"""Read-only SNMP v1/v2c probe for Cudy MAC forwarding tables (PySNMP 7.1)."""

import argparse
import asyncio
import getpass
import math
import os
import re
import sys


TABLES = (
    ("BRIDGE-MIB: MAC addresses", "1.3.6.1.2.1.17.4.3.1.1", "bridge_address"),
    ("BRIDGE-MIB: MAC -> bridge port", "1.3.6.1.2.1.17.4.3.1.2", "bridge_port"),
    ("BRIDGE-MIB: MAC entry status", "1.3.6.1.2.1.17.4.3.1.3", "bridge_status"),
    ("Q-BRIDGE-MIB: FDB ID + MAC -> bridge port", "1.3.6.1.2.1.17.7.1.2.2.1.2", "qbridge_port"),
    ("Q-BRIDGE-MIB: FDB ID + MAC entry status", "1.3.6.1.2.1.17.7.1.2.2.1.3", "qbridge_status"),
    ("BRIDGE-MIB: bridge port -> ifIndex", "1.3.6.1.2.1.17.1.4.1.2", "bridge_ifindex"),
    ("IF-MIB: ifIndex -> interface description", "1.3.6.1.2.1.2.2.1.2", "if_descr"),
)
FDB_STATUS = {1: "other", 2: "invalid", 3: "learned", 4: "self", 5: "mgmt"}
SNMP_EXCEPTIONS = ("EndOfMibView", "NoSuchObject", "NoSuchInstance")


def mac_address(text):
    if not re.fullmatch(r"(?:[0-9a-fA-F]{12}|(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2})", text):
        raise argparse.ArgumentTypeError("Expected a MAC such as AA:BB:CC:DD:EE:FF")
    return tuple(bytes.fromhex(text.replace(":", "").replace("-", "")))


def fdb_index(kind, suffix):
    """Decode the fixed-length MAC index, preserving the Q-BRIDGE FDB ID."""
    expected = 7 if kind.startswith("qbridge_") else 6
    if len(suffix) != expected or not all(0 <= b <= 255 for b in suffix[-6:]):
        raise ValueError("Malformed FDB index")
    return (suffix[0] if expected == 7 else None, ":".join(f"{b:02X}" for b in suffix[-6:]))


def record_row(kind, suffix, value, entries, port_indexes, descriptions):
    if kind in ("bridge_ifindex", "if_descr"):
        if len(suffix) != 1 or suffix[0] < 1:
            raise ValueError("Malformed interface/bridge-port index")
        if kind == "bridge_ifindex":
            index = int(value)
            if index < 1:
                raise ValueError("Invalid ifIndex")
            port_indexes[suffix[0]] = index
        else:
            descriptions[suffix[0]] = value.prettyPrint()
        return ""
    family = "qbridge" if kind.startswith("qbridge_") else "bridge"
    key = fdb_index(kind, suffix)
    field = kind.split("_", 1)[1]
    if field in ("port", "status"):
        parsed = int(value)
        if field == "port" and not 0 <= parsed <= 65535:
            raise ValueError("Invalid bridge port")
    else:
        parsed = value.prettyPrint()
    entries[family].setdefault(key, {})[field] = parsed
    detail = f"  | MAC={key[1]}"
    if key[0] is not None:
        detail += f"  FDB ID={key[0]}"
    if field == "port":
        detail += f"  bridge_port={parsed}"
    elif field == "status":
        detail += f"  status={FDB_STATUS.get(parsed, 'unknown')}({parsed})"
    return detail


def print_summary(entries, port_indexes, descriptions):
    count = 0
    learned = 0
    print("\n--- MAC forwarding summary ---")
    for family, rows in entries.items():
        for (fdb, mac), fields in sorted(rows.items()):
            count += 1
            port = fields.get("port")
            index = port_indexes.get(port) if port else None
            status = fields.get("status")
            learned += status == 3
            state = "unknown (not returned)" if status is None else f"{FDB_STATUS.get(status, 'unknown')}({status})"
            port_label = "unknown" if port is None else ("0 (not learned)" if port == 0 else str(port))
            fdb_label = f"  FDB ID={fdb}" if fdb is not None else ""
            print(f"{family.upper()}{fdb_label}  MAC={mac}  bridge_port={port_label}  "
                  f"ifIndex={index if index is not None else 'unknown'}  "
                  f"interface={descriptions.get(index, 'unknown')!r}  status={state}")
    print(f"\nMAC rows returned: {count} (counted once per source/FDB/MAC; sources may overlap).")
    print(f"Confirmed learned rows: {learned}; other/unknown statuses are shown separately above.")
    print("Bridge port is not necessarily the front-panel port; interface names use the returned ifIndex mapping.")
    print("FDB ID is not necessarily VLAN ID. Separate column walks are not an atomic snapshot.")
    if not count:
        print("No MAC data confirmed. This does NOT prove that no devices are connected.")
    return count


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="10.110.3.241", help="Switch IP (default: R1)")
    parser.add_argument("--port", type=int, default=161, help="SNMP UDP port")
    parser.add_argument("--version", choices=("1", "2c"), default="2c", help="SNMP version (default: 2c)")
    parser.add_argument("--timeout", type=float, default=3, help="Timeout per request in seconds")
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--max-rows", type=int, default=2048, help="Maximum rows per table")
    parser.add_argument("--diagnose", action="store_true", help="Probe identity and list up to 100 OIDs per diagnostic subtree")
    parser.add_argument("--mac", type=mac_address, help="Exact GET for one known MAC instead of walking tables")
    parser.add_argument("--fdb-id", type=int, help="Also query this Q-BRIDGE FDB ID with --mac (not necessarily VLAN ID)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not math.isfinite(args.timeout) or args.timeout <= 0 or args.retries < 0 or args.max_rows < 1:
        parser.error("Invalid port, timeout, retries or max-rows")
    if args.fdb_id is not None:
        if args.mac is None:
            parser.error("--fdb-id requires --mac")
        if not 0 <= args.fdb_id <= 4294967295:
            parser.error("--fdb-id must be between 0 and 4294967295")
    return args


async def probe(args, community):
    try:
        from pysnmp.hlapi.v3arch.asyncio import (
            CommunityData, ContextData, ObjectIdentity, ObjectType,
            SnmpEngine, UdpTransportTarget, get_cmd, next_cmd,
        )
    except ImportError:
        print("Install dependencies: python -m pip install -r tools/cudy-snmp/requirements.txt", file=sys.stderr)
        return 1

    engine = SnmpEngine()
    try:
        target = await UdpTransportTarget.create(
            (args.host, args.port), timeout=args.timeout, retries=args.retries
        )
        # PySNMP message processing models: 0 = SNMP v1, 1 = SNMP v2c.
        auth = CommunityData(community, mpModel=0 if args.version == "1" else 1)
        context = ContextData()

        def check(result):
            error, status, index, bindings = result
            if error:
                raise RuntimeError(str(error))
            if status:
                raise RuntimeError(f"{status.prettyPrint()} (binding {index})")
            return bindings

        def print_response(request_oid, result, operation="GETNEXT"):
            _, status, index, bindings = result
            print(f"{operation} request OID: {request_oid}")
            print(f"SNMP response: error-status={int(status)}, error-index={int(index)}")
            for oid, value in bindings:
                print(f"Returned binding: {oid.prettyPrint()} = {value.__class__.__name__}: {value.prettyPrint()}")

        print(f"Target: {args.host}:{args.port}, SNMP v{args.version}, read-only")
        bindings = check(await get_cmd(
            engine, auth, target, context,
            ObjectType(ObjectIdentity("1.3.6.1.2.1.1.1.0")),
            lookupMib=False,
        ))
        for oid, value in bindings:
            print(f"System: {value.prettyPrint()}")

        if args.diagnose:
            for label, oid in (
                ("sysObjectID", "1.3.6.1.2.1.1.2.0"),
                ("ifNumber", "1.3.6.1.2.1.2.1.0"),
                ("dot1dBaseNumPorts", "1.3.6.1.2.1.17.1.2.0"),
            ):
                try:
                    for name, value in check(await get_cmd(
                        engine, auth, target, context,
                        ObjectType(ObjectIdentity(oid)), lookupMib=False,
                    )):
                        print(f"{label}: {name.prettyPrint()} = {value.__class__.__name__}: {value.prettyPrint()}")
                except RuntimeError as exc:
                    print(f"{label}: {exc}")

        entries = {"bridge": {}, "qbridge": {}}
        port_indexes = {}
        descriptions = {}
        failures = 0
        incomplete = False
        if args.mac is not None:
            print("\n--- Exact MAC lookup (GET only; no table walks) ---")
            if args.diagnose:
                print("Diagnostic scalars shown above; subtree walks skipped in --mac mode.")

            async def read_one(root, suffix, kind):
                nonlocal failures
                request_oid = root + "." + ".".join(map(str, suffix))
                try:
                    result = await get_cmd(
                        engine, auth, target, context,
                        ObjectType(ObjectIdentity(request_oid)), lookupMib=False,
                    )
                    print_response(request_oid, result, "GET")
                    if not result[0] and args.version == "1" and int(result[1]) == 2:
                        print("SNMP v1 noSuchName: this exact instance is not accessible.")
                        return
                    returned = check(result)
                    if len(returned) != 1:
                        raise RuntimeError("Expected one binding for an exact GET")
                    oid, value = returned[0]
                    if tuple(oid) != tuple(map(int, request_oid.split("."))):
                        raise RuntimeError("GET returned a different OID; response not used")
                    if value.__class__.__name__ in SNMP_EXCEPTIONS:
                        print("Exact instance not accessible: object may be unsupported/restricted or entry absent.")
                        return
                    record_row(kind, suffix, value, entries, port_indexes, descriptions)
                except (RuntimeError, ValueError, TypeError, OverflowError) as exc:
                    failures += 1
                    print(f"Direct GET failed: {exc}", file=sys.stderr)

            for _, root, kind in TABLES:
                if kind.startswith("bridge_") and kind != "bridge_ifindex":
                    await read_one(root, args.mac, kind)
                elif kind.startswith("qbridge_") and args.fdb_id is not None:
                    await read_one(root, (args.fdb_id,) + args.mac, kind)
            if args.fdb_id is None:
                print("Q-BRIDGE lookup skipped: supply --fdb-id if known; FDB/VLAN ID is not guessed.")
            ports = {row["port"] for rows in entries.values() for row in rows.values() if row.get("port", 0) > 0}
            for port in sorted(ports):
                await read_one("1.3.6.1.2.1.17.1.4.1.2", (port,), "bridge_ifindex")
            for index in sorted(set(port_indexes.values())):
                await read_one("1.3.6.1.2.1.2.2.1.2", (index,), "if_descr")
            mac_count = print_summary(entries, port_indexes, descriptions)
            return 1 if failures or not mac_count else 0

        tables = list(TABLES)
        if args.diagnose:
            tables.extend((
                ("Diagnostic MIB-2 OIDs (values hidden)", "1.3.6.1.2.1", "diagnostic"),
                ("Diagnostic enterprise OIDs (values hidden)", "1.3.6.1.4.1", "diagnostic"),
            ))
        for label, root, kind in tables:
            print(f"\n--- {label} [{root}] ---")
            prefix = tuple(map(int, root.split(".")))
            current = prefix
            count = 0
            limit = min(args.max_rows, 100) if kind == "diagnostic" else args.max_rows
            try:
                # One extra GETNEXT distinguishes a full table from truncated output.
                for _ in range(limit + 1):
                    request_oid = ".".join(map(str, current))
                    result = await next_cmd(
                        engine, auth, target, context,
                        ObjectType(ObjectIdentity(request_oid)),
                        lookupMib=False,
                    )
                    if not result[0] and result[1]:
                        print_response(request_oid, result)
                        if args.version == "1" and int(result[1]) == 2:
                            print("SNMP v1 noSuchName: agent reports no next accessible OID; stopping this walk.")
                            break
                    bindings = check(result)
                    if not bindings:
                        print_response(request_oid, result)
                        print("GETNEXT returned no variable bindings.")
                        break
                    oid, value = bindings[0]
                    if value.__class__.__name__ in SNMP_EXCEPTIONS:
                        print_response(request_oid, result)
                        print("GETNEXT returned an SNMP exception; stopping this walk.")
                        break
                    numeric = tuple(oid)
                    if numeric[:len(prefix)] != prefix:
                        print_response(request_oid, result)
                        print("GETNEXT left subtree: returned binding is outside the requested table; stopping this walk.")
                        break
                    if numeric <= current:
                        raise RuntimeError("Non-increasing OID; stopping walk")
                    if count >= limit:
                        print(f"Row limit ({limit}) reached; output is incomplete.")
                        if kind != "diagnostic":
                            incomplete = True
                        break
                    suffix = numeric[len(prefix):]
                    detail = ""
                    if kind != "diagnostic":
                        try:
                            detail = record_row(kind, suffix, value, entries, port_indexes, descriptions)
                        except (ValueError, TypeError, OverflowError) as exc:
                            failures += 1
                            print(f"Invalid table row {oid.prettyPrint()}: {exc}", file=sys.stderr)
                    if kind == "diagnostic":
                        print(f"{oid.prettyPrint()} = {value.__class__.__name__} (value hidden)")
                    else:
                        print(f"{oid.prettyPrint()} = {value.__class__.__name__}: {value.prettyPrint()}{detail}")
                    count += 1
                    current = numeric
                if not count:
                    print("No accessible rows: table may be empty, unsupported or restricted.")
            except RuntimeError as exc:
                failures += 1
                print(f"Table read failed: {exc}", file=sys.stderr)
        mac_count = print_summary(entries, port_indexes, descriptions)
        return 1 if failures or not mac_count else (2 if incomplete else 0)
    except (RuntimeError, OSError) as exc:
        print(f"SNMP probe failed: {exc}", file=sys.stderr)
        print(f"Check VPN connectivity, SNMP v{args.version}, read community and UDP 161 access.", file=sys.stderr)
        return 1
    finally:
        engine.close_dispatcher()


def main():
    args = arguments()
    community = os.environ.get("CUDY_SNMP_COMMUNITY") or getpass.getpass("SNMP read community: ")
    if not community:
        print("Read community cannot be empty.", file=sys.stderr)
        return 1
    return asyncio.run(probe(args, community))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        sys.exit(130)

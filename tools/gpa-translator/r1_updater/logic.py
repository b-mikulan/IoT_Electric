"""Recognize and rewrite the one- and two-output R1 Facade Lights graphs."""

import base64
from collections import Counter
import hashlib
import json
import re
from uuid import UUID, uuid5

from .project import NS, field, one, require, uid, xml_field


def digest(data):
    return base64.b64encode(hashlib.sha1(data).digest()).decode("ascii")


def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def load_graph(project, page):
    files = project.files
    logic = page.split("/logicpages/")[0]
    app = logic.split("/logic/")[0]
    device = field(project.xml(page), "DeviceId")
    tile = one((project.xml(p) for p in project.children(logic + "/devicetiles")
                if field(project.xml(p), "DeviceId") == device), "Uređaj stranice Facade Lights")
    manifest_path = app + "/roots/$" + field(tile, "TableOfContents") + ".bin"
    manifest = json.loads(files[manifest_path])
    matches = []
    for entry in manifest["Graphs"]:
        path = app + "/" + entry["Uri"] + ".bin"
        raw = files[path]
        if uid(page).encode() not in raw:
            continue
        pages = json.loads(raw)
        for graph in pages:
            if graph["PageId"] == uid(page):
                require(entry["IsActive"] is True and field(project.xml(page), "IsActive") == "True",
                        "Stranica Facade Lights nije aktivna u oba zapisa.")
                require(len(pages) == 1 and graph["PageName"] == field(project.xml(page), "LogicPageName")
                        and entry["Hash"] == digest(raw), "Neusklađen JSON graf ili SHA-1 za Facade Lights.")
                matches.append((manifest_path, manifest, entry, path, graph))
    return one(matches, "JSON graf Facade Lights u manifestu uređaja")


def route(project, edge_path, start, source):
    raw = project.files[edge_path + ".xml"]
    edge = project.xml(edge_path)
    require(field(edge, "IsUserModified") == "False" and field(edge, "IsVirtual") == "False",
            f"Neočekivana ručno uređena ili virtualna veza {edge_path}.")
    end = edge.findall(".//" + NS + "Segment")[-1].attrib["EndPoint"]
    sx, sy = map(int, start.split(","))
    ex, ey = map(int, end.split(","))
    points = [start]
    if sx != ex and sy != ey:
        mid = (sx + ex) // 2
        points.extend((f"{mid},{sy}", f"{mid},{ey}"))
    points.append(end)
    newline = b"\r\n" if b"\r\n" in raw else b"\n"
    segments = newline.join(f'    <conf:Segment EndPoint="{p}" />'.encode() for p in points)
    raw = xml_field(raw, "From", field(edge, "From"), source)
    raw, count = re.subn(b"(<conf:Segments>).*?(</conf:Segments>)",
                         lambda m: m[1] + newline + segments + newline + b"  " + m[2], raw, flags=re.S)
    require(count == 1, f"Neprepoznata geometrija veze {edge_path}.")
    project.files[edge_path + ".xml"] = raw


def update_logic(project, page, mode_point):
    manifest_path, manifest, entry, path, graph = load_graph(project, page)
    nodes = graph["Nodes"]
    by_id = {n["Id"]: n for n in nodes}
    paths = {uid(p): p for p in project.children(page + "/logicnodes")}
    require(len(by_id) == len(nodes) and set(paths) == set(by_id),
            "XML i JSON imaju različite čvorove na stranici Facade Lights.")
    roles = {}
    outputs = []
    for node_id, node_path in paths.items():
        xml = project.xml(node_path)
        node = by_id[node_id]
        kind = node["Type"].removeprefix("LogicModule.Nodes.")
        require(node["Type"] == field(xml, "Type") and node["Version"] == field(xml, "Version"),
                f"Neusklađen tip ili verzija čvora {node_path}.")
        if kind in ("DatapointAction", "DatapointEvent"):
            param = one(xml.findall(".//" + NS + "Parameter[@Name='datapoint']"), node_path)
            target = project.base + param.attrib["EntityId"]
            logical = field(project.xml(target), "LogicalName")
            dp = node["Config"]["datapoint"]
            require("/knxdatapoints/" in target and dp["Address"].split(":")[-1] == logical,
                    f"Neusklađena KNX točka čvora {node_path}.")
            if kind == "DatapointAction":
                require(dp["PortType"] == "PERCENT", f"Neočekivani izlaz {logical}.")
                outputs.append((node_id, target))
                continue
            require(logical in ("FLLMode", "FLLSet") and
                    (logical != "FLLMode" or target == mode_point), f"Neočekivani ulaz {logical}.")
            kind = logical
        require(kind in ("FLLSet", "FLLMode", "SendByChange", "Blocker", "NotGate")
                and kind not in roles, f"Neočekivan ili ponovljen čvor {kind}.")
        roles[kind] = node_id
    require(len(outputs) in (1, 2) and len({target for _, target in outputs}) == len(outputs),
            "Očekivan je jedan ili dva različita izlaza rasvjete.")
    original = "Blocker" in roles
    expected_roles = {"FLLSet", "SendByChange"}
    if original:
        expected_roles.update(("Blocker", "FLLMode", "NotGate"))
    require(set(roles) == expected_roles, "Nepotpuna ili neočekivana grana FLLMode na Facade Lights.")
    send = roles["SendByChange"]
    expected = [(roles["FLLSet"], "Output", send, "Input")]
    output_source = send
    if original:
        block = roles["Blocker"]
        expected.extend(((send, "Output", block, "Input"),
                         (roles["FLLMode"], "Output", roles["NotGate"], "Input"),
                         (roles["NotGate"], "Output", block, "Enabled")))
        output_source = block
    expected.extend((output_source, "Output", node_id, "Input") for node_id, _ in outputs)
    edges = {}
    for edge_path in project.children(page + "/logicconnections"):
        e = project.xml(edge_path)
        edges[edge_path] = tuple(field(e, k) for k in ("From", "FromName", "To", "ToName"))
    index = {str(i): n["Id"] for i, n in enumerate(nodes)}
    connections = graph["Connections"]
    json_edges = [(index[c["SrcNode"]], c["SrcPort"], index[c["TgtNode"]], c["TgtPort"])
                  for c in connections]
    require(Counter(edges.values()) == Counter(expected) == Counter(json_edges),
            "Veze Facade Lights u XML-u ili JSON-u odstupaju od očekivanog sklopa.")
    if not original:
        return False, len(outputs)

    remove_ids = {roles[k] for k in ("Blocker", "NotGate", "FLLMode")}
    incoming = one((p for p, e in edges.items() if e[0] == send), "Veza Send-by-change → Block")
    start = project.xml(incoming).findall(".//" + NS + "Segment")[0].attrib["EndPoint"]
    remove_entities = {paths[node_id] for node_id in remove_ids}
    for edge_path, (src, _, dst, _) in edges.items():
        if src == block:
            route(project, edge_path, start, send)
        elif src in remove_ids or dst in remove_ids:
            remove_entities.add(edge_path)
    project.remove_entities(remove_entities, set())
    graph["Nodes"] = [n for n in nodes if n["Id"] not in remove_ids]
    new_indices = {n["Id"]: str(i) for i, n in enumerate(graph["Nodes"])}
    graph["Connections"] = []
    for c, (src, _, dst, _) in zip(connections, json_edges):
        if src == block:
            src = send
        if src in new_indices and dst in new_indices:
            graph["Connections"].append(dict(c, SrcNode=new_indices[src], TgtNode=new_indices[dst]))
    raw = json_bytes([graph])
    entry["Hash"] = digest(raw)
    entry["Uri"] = "files/$" + str(uuid5(UUID(uid(page)), entry["Hash"]))
    new_path = path.split("/files/")[0] + "/" + entry["Uri"] + ".bin"
    require(new_path not in project.files, f"Kolizija izlazne putanje {new_path}.")
    project.files[new_path] = raw
    project.files[manifest_path] = json_bytes(manifest)
    del project.files[path]
    project.removed.add(uid(path[:-4]))
    return True, len(outputs)

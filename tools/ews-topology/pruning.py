"""Conservative catalog scope: preserve equipment, points, histories and alarms."""

from collections import defaultdict, deque


CATALOG_FOLDERS = frozenset({
    "Programs", "Graphics", "Trend Charts", "Views", "Dashboards", "Schedules",
    "Diagnostic Files", "Certificate Files",
})


def catalog_reason(container_id, name, metadata, root_id, parent_name=None):
    """An explicit scan root always wins. Unknown structures are not leaf rules."""
    if container_id == root_id:
        return ""
    kind = metadata.get("type", "")
    if kind == "folder" and name in CATALOG_FOLDERS:
        return f"Catalog excludes technical folder: {name}"
    if kind in ("graphic", "schedule", "mentaprogram"):
        return f"Catalog excludes presentation/program object type: {kind}"
    if kind == "structure" and name == "NC" and parent_name == "Alarms":
        return "Catalog excludes alarm notification-class configuration: NC"
    if container_id.startswith("40https://brickschema.org/"):
        return "Catalog excludes ontology graph expansion"
    return ""


def pruning_reasons(rows, links, root_id):
    """Use actual graph edges, keeping descendants reachable by an allowed alias.

    Folder names identify scope; there is deliberately no general path-prefix,
    'structure', Points, Values, IO Resources, Logs, Alarms or System exclusion.
    """
    nodes = {row["id"]: row for row in rows}
    children = defaultdict(set)
    for link in links:
        children[link["parent_id"]].add(link["id"])
    for row in rows:
        if row["parent_id"] is not None:
            children[row["parent_id"]].add(row["id"])
    reasons = {}
    for row in rows:
        parent = nodes.get(row["parent_id"], {})
        reason = catalog_reason(row["id"], row["name"], row["metadata"], root_id, parent.get("name"))
        if reason:
            reasons[row["id"]] = reason

    reachable = set()
    queue = deque([root_id])
    while queue:
        current = queue.popleft()
        if current in reachable or current in reasons:
            continue
        reachable.add(current)
        queue.extend(children[current] - reachable)

    # A folder may already have been read in a previous full scan. Its pending
    # descendants still need exclusion, but an allowed second parent keeps them.
    queue = deque((node_id, node_id) for node_id in reasons)
    while queue:
        current, excluded_root = queue.popleft()
        for child in children[current]:
            if child in reachable or child in reasons:
                continue
            reasons[child] = f"Below excluded branch: {excluded_root}"
            queue.append((child, excluded_root))
    return reasons

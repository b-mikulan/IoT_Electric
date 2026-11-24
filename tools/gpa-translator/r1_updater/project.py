"""Targeted edits to GPA entities and their two-sided associations."""

import base64
from collections import defaultdict
import hashlib
import hmac
import re
import secrets
import xml.etree.ElementTree as ET

from gpa_translator.translate import NS


def require(condition, message):
    if not condition:
        raise ValueError(message)


def one(items, description):
    items = list(items)
    require(len(items) == 1, f"{description} — očekivano 1, pronađeno {len(items)}.")
    return items[0]


def field(element, name):
    return element.findtext(NS + name, "")


def uid(path):
    return path.rsplit("/$", 1)[1]


def xml_field(raw, name, old, new):
    start, end = f"<conf:{name}>", f"</conf:{name}>"
    before = (start + old + end).encode()
    require(raw.count(before) == 1, f"Neočekivan XML zapis polja {name}.")
    return raw.replace(before, (start + new + end).encode())


class Project:
    def __init__(self, files):
        self.files = files
        self.base = one((k[:-4] for k in files if k.count("/") == 1), "Korijen projekta")
        self.pairs = defaultdict(list)
        self.removed = set()
        for path in files:
            if path.endswith(".assoc"):
                self.pairs[path.rsplit("/", 1)[1]].append(path)

    def xml(self, entity):
        path = entity + ".xml"
        require(path in self.files, f"Nedostaje {path}.")
        node = ET.fromstring(self.files[path])
        require(field(node, "EntityId") == uid(entity), f"EntityId ne odgovara putanji {path}.")
        return node

    def children(self, folder, suffix=".xml"):
        prefix = folder + "/"
        return [k.removesuffix(suffix) for k in self.files
                if k.startswith(prefix) and k.endswith(suffix) and "/" not in k[len(prefix):]]

    def named(self, folder, name):
        return [p for p in self.children(self.base + "/" + folder)
                if field(self.xml(p), "EntityName") == name]

    def links(self, owner, folder):
        return self.children(owner + "/" + folder, ".assoc")

    def pair(self, link):
        paths = self.pairs[link.rsplit("/", 1)[1] + ".assoc"]
        require(len(paths) == 2 and link + ".assoc" in paths, f"Nepotpuna veza {link}.")
        ends = None
        owners = set()
        for path in paths:
            node = ET.fromstring(self.files[path])
            current = {x.attrib["href"] for x in node.findall(NS + "End")}
            require(node.get("selfurl") == path[:-6] and node.get("uid") == uid(link)
                    and len(current) == 2 and (ends is None or current == ends),
                    f"Nedosljedni krajevi veze {link}.")
            owners.add(path.rsplit("/", 2)[0])
            ends = current
        require(owners == ends, f"Putanje ne odgovaraju krajevima veze {link}.")
        return paths, ends

    def target(self, link, owner):
        _, ends = self.pair(link)
        require(owner in ends, f"Veza ne pripada objektu {owner}.")
        return one(ends - {owner}, link)

    def remove_entities(self, entities, allowed_links):
        # Remove only the explicitly identified XML entities and both copies of
        # their known links. Unexpected children must be accounted for first.
        paths = set()
        for entity in entities:
            paths.add(entity + ".xml")
            for path in self.files:
                if not path.startswith(entity + "/"):
                    continue
                if path.removesuffix(".xml") in entities:
                    continue
                owner, folder, _ = path.rsplit("/", 2)
                require(path.endswith(".assoc") and owner in entities and folder in allowed_links,
                        f"Neočekivan sadržaj ispod objekta za brisanje: {path}")
                copies, _ = self.pair(path[:-6])
                paths.update(copies)
        for path in paths:
            del self.files[path]
        self.removed.update(uid(entity) for entity in entities)

    def check_removed(self):
        if self.removed:
            pattern = re.compile(b"|".join(re.escape(i.encode()) for i in self.removed), re.I)
            for path, raw in self.files.items():
                active_graph = "/applications/" in path and ("/roots/" in path or
                               ("/files/" in path and raw.lstrip().startswith(b"[")))
                if path.endswith((".xml", ".assoc")) or active_graph:
                    require(not pattern.search(raw), f"Preostala referenca na obrisani objekt u {path}.")


SENSOR_NAME = re.compile(r"sen[sz]or\s+loggia(?:\s+\d+)*", re.I)


def password_record(password, salt):
    """GPA 6 User.Password: unpadded Base64 SHA-256 followed by the salt text."""
    digest = hashlib.sha256((password + salt).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii").rstrip("=") + salt


def set_user_password(project, password):
    require(bool(password), "Nova lozinka računa User je prazna.")
    user = one(project.named("users", "User"), "Račun User")
    xml = project.xml(user)
    element = one(xml.findall(NS + "Password"), "Polje Password računa User")
    require(not element.attrib and len(element) == 0, "Neočekivan oblik polja Password.")
    require(field(xml, "ResetPassword").lower() == "false", "Račun User ima neočekivanu postavku ResetPassword.")
    old = element.text or ""
    if old:
        require(re.fullmatch(r"[A-Za-z0-9+/]{65}", old), "Neprepoznat zapis lozinke računa User.")
        if hmac.compare_digest(old, password_record(password, old[43:])):
            return False
    salt = base64.b64encode(secrets.token_bytes(16)).decode("ascii").rstrip("=")
    new = password_record(password, salt)
    path = user + ".xml"
    raw = project.files[path]
    if not old:
        raw = re.sub(rb"<conf:Password\s*/>", b"<conf:Password></conf:Password>", raw)
    project.files[path] = xml_field(raw, "Password", old, new)
    return True


def update_widgets(project, mode_point):
    targets = set()
    timers = set()
    labels = []
    for widget in project.children(project.base + "/channelviews"):
        node = project.xml(widget)
        name = field(node, "EntityName")
        if not SENSOR_NAME.fullmatch(name.strip()):
            continue
        require(field(node, "ChannelTypeUrn") == "de.gira.schema.channels.Switch",
                f"Widget {name} nije očekivanog tipa Switch.")
        point = one(project.children(widget + "/datapointviews"), f"{name}: podatkovna točka")
        point_xml = project.xml(point)
        require(field(point_xml, "LogicalName") == "OnOff"
                and field(point_xml, "DataPointUrn").endswith(":FLLMode"),
                f"{name}: OnOff nije vezan na FLLMode.")
        link = one(project.links(point, "knxdatapoints"), f"{name}: KNX veza")
        require(project.target(link, point) == mode_point, f"{name}: OnOff nije povezan na FLLMode.")
        targets.update((widget, point))
        labels.append(name)
        for link in project.links(widget, "functiontimerchannels"):
            timer = project.target(link, widget)
            require(len(project.links(timer, "channelviewtrigger")) == 1,
                    f"{name}: više widgeta dijeli timer {timer}.")
            timers.add(timer)
    linked_points = {project.target(link, mode_point)
                     for link in project.links(mode_point, "datapointviews")}
    require(linked_points == {p for p in targets if "/datapointviews/" in p},
            "FLLMode ima vezu s neprepoznatim widgetom.")
    for timer in timers:
        require(field(project.xml(timer), "ChannelTypeUrn") == "de.gira.schema.channels.FunctionTimer",
                f"Neočekivan tip timera {timer}.")
        timer_points = project.children(timer + "/devicedatapoints")
        require({field(project.xml(p), "EntityName") for p in timer_points}
                == {"Time-Index", "Trigger-Value", "Execute", "Trigger", "Teach"}
                and len(timer_points) == 5, f"Neočekivane podatkovne točke timera {timer}.")
        expected_links = {link + ".assoc" for link in project.links(timer, "channelviewtrigger")}
        for path in project.files:
            if path.startswith(timer + "/") and path.endswith(".assoc"):
                require(path in expected_links, f"Timer ima dodatnu vezu {path}.")
        for entity in [timer, *timer_points]:
            path = entity + ".xml"
            for key in ("Visible", "Enabled"):
                project.files[path] = xml_field(project.files[path], key, "true", "false")
    project.remove_entities(targets, {"users", "profiles", "devices", "locations", "trades",
                                      "functiontimerchannels", "knxdatapoints"})
    return labels


def update_users(project):
    user = one(project.named("users", "User"), "Račun User")
    admin = one(project.named("usergroups", "Administrator"), "Grupa Administrator")
    regular = one(project.named("usergroups", "User"), "Grupa User")
    link = one(project.links(user, "groups"), "Članstvo računa User")
    group = project.target(link, user)
    require(group in (regular, admin), "Račun User ima neočekivanu ulogu.")
    if group != admin:
        paths, _ = project.pair(link)
        for path in paths:
            dest = path.replace(regular + "/", admin + "/")
            require(dest == path or dest not in project.files, f"Veza već postoji: {dest}")
            project.files[dest] = project.files.pop(path).replace(uid(regular).encode(), uid(admin).encode())
        project.pairs[link.rsplit("/", 1)[1] + ".assoc"] = [
            p.replace(regular + "/", admin + "/") for p in paths]
    removed = []
    for name in ("Dado", "Damjan"):
        users = project.named("users", name)
        rights = project.named("rights", name + "FullAccess")
        profiles = [k[:-4] for k in project.files if "/typedelements/" in k and k.endswith(".xml")
                    and field(project.xml(k[:-4]), "Type") == "Profile"
                    and field(project.xml(k[:-4]), "EntityName") == name]
        if not (users or profiles or rights):
            continue
        account = one(users, "Račun " + name)
        profile = one(profiles, "Profil " + name)
        require(field(project.xml(profile), "Subtype") == "User", f"{name}: neočekivani tip profila.")
        right = one(rights, "Pravo " + name)
        for owner, folder, target in ((account, "rights", right), (right, "users", account),
                                      (profile, "profilerights", right), (right, "profiles", profile)):
            link = one(project.links(owner, folder), f"{name}: {folder}")
            require(project.target(link, owner) == target, f"{name}: neočekivana veza {folder}.")
        require(not project.links(right, "groups"), f"{name}: pravo je dodijeljeno i grupi.")
        project.remove_entities({account, profile, right},
                                {"channelviews", "groups", "rights", "users", "profiles",
                                 "profilechannelviews", "profilerights"})
        removed.append(name)
    return group != admin, removed

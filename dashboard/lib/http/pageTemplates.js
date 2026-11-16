// Server-side composition for dashboard pages that share markup.
//
//   {{> name flagA flagB}}   alone on a line: insert partial "name", rendered with those flags
//   {{#flag}} ... {{/flag}}  kept only when the including page lists the flag
//   {{^flag}} ... {{/flag}}  kept only when it does not
//   {{! note }}              alone on a line: dropped
//
// A marker alone on its line is removed together with that line, so a block
// variant leaves no blank line in the served page.

const STANDALONE_NOTE = /^[ \t]*\{\{![^}]*\}\}[ \t]*(?:\r?\n|$)/gm;
const STANDALONE_MARKER = /^[ \t]*(\{\{[#^/][\w-]+\}\})[ \t]*(?:\r?\n|$)/gm;
const SECTION = /\{\{([#^])([\w-]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
const INCLUDE = /^[ \t]*\{\{> *([\w-]+)((?: +[\w-]+)*) *\}\}[ \t]*(?:\r?\n|$)/gm;
const UNRESOLVED = /\{\{[#^/>!][^}]*\}\}/;

function renderSections(source, flags = new Set()) {
  const keep = (text) => text.replace(SECTION, (match, kind, name, body) => (flags.has(name) === (kind === "#") ? keep(body) : ""));
  return keep(source.replace(STANDALONE_NOTE, "").replace(STANDALONE_MARKER, "$1"));
}

function composePage(source, readPartial) {
  const page = source.replace(INCLUDE, (match, name, flagList) => {
    const partial = readPartial(name);
    if (typeof partial !== "string") throw new Error(`Page partial "${name}" does not exist.`);
    return renderSections(partial, new Set(flagList.split(" ").filter(Boolean)));
  });
  // Anything still shaped like a marker is a typo or an unbalanced section;
  // fail instead of sending it to the browser.
  const unresolved = page.match(UNRESOLVED);
  if (unresolved) throw new Error(`Unresolved page template marker ${unresolved[0]}.`);
  return page;
}

module.exports = { composePage, renderSections };

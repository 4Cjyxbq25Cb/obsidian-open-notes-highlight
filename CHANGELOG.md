# Changelog

## 1.4.2

Documentation release — no changes to the plugin's behavior.

- **Transparency note:** the plugin description and the README now state that
  the code was written with Claude (Anthropic) and is curated by the author.

---

## 1.4.1

Performance release — no changes to settings, defaults, or how highlighting looks.

- **Smoother note switching in large graphs.** Open, pinned, and linked notes are
  now looked up through an index instead of being searched node by node. On a
  7,500-note test graph, the frame right after switching notes dropped from
  about 140 ms to about 17 ms, which removes the visible hitch.
- **One update per navigation.** Opening a note fires several workspace events
  at once; they are now folded into a single update.
- **Linked notes are recomputed only when needed** — when the set of open notes
  or the vault's links change — and now also refresh as soon as you add or
  remove a link, instead of at the next note switch.
- **Less work per frame:** colors are parsed once per change, node color and
  size are only written when they differ, edges are skipped while edge
  highlighting is off, and the render loop idles while highlighting is disabled.

---

## 1.4.0

### Highlight the notes of any saved workspace

You can now point the plugin at a **saved workspace** and see the notes *it* has
open lit up in the graph — without loading that workspace. Your current layout
and the graph you are looking at stay exactly where they are.

Useful when you keep a workspace per project, client, or topic and want to see at
a glance how its notes sit in the graph, or how two workspaces overlap, without
switching back and forth.

**How to use it**

1. Enable the **Workspaces** core plugin (Settings → Core plugins → Workspaces)
   and save at least one workspace, if you have not already.
2. Open the graph view and set **Scope** to `Workspace` — either in the in-graph
   control panel or in the plugin settings.
3. Pick a workspace from the dropdown that appears right below. The graph updates
   immediately.

Everything else works as before: colors, size, dimming, linked notes, and edge
highlighting all apply to the workspace's notes. Notes that are pinned inside the
saved workspace keep the pinned color, exactly as in the other scopes.

Switch **Scope** back to `All panels` or `Active panel` at any time to return to
highlighting the notes you actually have open.

### Settings are now searchable (Obsidian 1.13+)

On Obsidian 1.13 and later, this plugin's settings show up in the global settings
search, so you can jump straight to "Dim opacity" or "Highlight edges" by typing
instead of hunting for the plugin first. Nothing changes on older versions.

### Notes

- The **Scope** control in the in-graph panel changed from an *Active panel only*
  checkbox to a dropdown with three options, to make room for the new mode. Your
  existing setting carries over unchanged.
- Settings that only apply when another option is on — linked-note opacity and
  edge opacity — are now hidden until you enable that option, instead of sitting
  there inert.
- If the Workspaces core plugin is disabled, or no workspace has been saved yet,
  the picker says so and nothing is highlighted — the other scopes are unaffected.
- No changes to defaults, colors, or any existing behavior.

---

## 1.3.2

Neutral defaults: size multiplier, dim opacity, and linked-note opacity now all
start at `1`, so a fresh install changes only the color of open notes until you
dial the other effects in yourself.

## 1.3.1

Plugin guideline compliance, proper cleanup of patched render objects on unload,
and per-frame caching of node status for lower overhead in large graphs.

## 1.3.0

Optional highlighting of **linked notes** (neighbors of an open or pinned note,
tinted at reduced opacity) and of **edges** touching an open or pinned note.

## 1.1.0

Node size is now a multiplier relative to the graph's own node size setting,
instead of an absolute value.

## 1.0.x

Initial releases: color highlighting, size boost, and dimming of open notes;
separate color for pinned notes; collapsible in-graph control panel; scope
setting for all panels vs. the active panel.

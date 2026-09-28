'use strict';

/**
 * Open Notes Graph Highlight — Obsidian Plugin
 *
 * Highlights currently open (and pinned) notes in the graph view by giving
 * them a custom color and enlarged size, while dimming all other nodes.
 * An in-graph control panel provides quick access to the main settings.
 *
 * ## How it works
 *
 * Obsidian's graph view is rendered by PixiJS, a WebGL/Canvas 2D engine.
 * The renderer owns a scene graph of nodes (circles) and re-renders every
 * animation frame. There is no official plugin API for customising individual
 * node appearance, so this plugin patches internal PixiJS display-object
 * properties directly via Object.defineProperty — intercepting property reads
 * at render time rather than trying to set values that the renderer would
 * immediately overwrite.
 *
 * Two properties are patched on each node's circle (a PIXI.DisplayObject):
 *   - `worldAlpha`      — controls opacity; used to dim non-open nodes
 *   - `worldTransform`  — the 2D affine matrix; used to override node scale
 *
 * A requestAnimationFrame loop runs continuously for each graph renderer,
 * calling `applyToNode` on every node every frame. This ensures newly added
 * nodes are patched promptly and that color / weight changes take effect
 * without waiting for a Obsidian-triggered redraw.
 */

const obsidian = require('obsidian');

// Default values for all persisted settings.
const DEFAULTS = {
  enabled: true,         // whether highlighting is active at all
  color: '#e06c75',      // highlight color for open (non-pinned) notes
  pinnedColor: '#61afef',// highlight color for pinned notes
  sizeMult: 1,           // multiplier applied to the graph's own node size
  dimOpacity: 1,         // opacity applied to non-highlighted nodes
  scope: 'all',          // 'all' = every panel, 'panel' = active panel only,
                         // 'workspace' = notes stored in a saved workspace layout
  workspaceName: '',     // which saved workspace to read when scope is 'workspace'
                         // (empty = the workspaces plugin's currently active one)
  highlightLinked: false,// whether notes linked to an open/pinned note get tinted too
  linkedOpacity: 1,      // worldAlpha used for linked notes (open/pinned notes always use 1)
  highlightEdges: false, // whether edges touching an open/pinned note get tinted in its color
  edgeOpacity: 1,        // worldAlpha used for highlighted edges
};

// Settings whose value shows or hides other settings; the imperative settings
// tab re-renders when one of them changes.
const RELAYOUT_KEYS = new Set(['scope', 'highlightLinked', 'highlightEdges']);

// ─── Settings Tab ────────────────────────────────────────────────────────────

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── Declarative settings (Obsidian 1.13+) ──────────────────────────────────
  //
  // 1.13 introduced a declarative settings API: instead of building controls
  // imperatively in display(), the tab describes them and Obsidian renders
  // them. The payoff is that the settings become findable through the global
  // settings search, which only indexes declared definitions.
  //
  // Both APIs are implemented side by side (the "dual support" pattern from
  // the migration guide): 1.13+ renders from getSettingDefinitions(), older
  // versions fall back to display(). display() therefore bails out early on
  // 1.13+ so the tab isn't rendered twice.

  // Settings live on the plugin's own `settings` object rather than being
  // persisted per key by Obsidian, so reads and writes are routed through
  // these overrides. Writing via saveSettings() keeps the side effects the
  // rest of the plugin depends on: it re-runs update(), pushes the new values
  // into every in-graph panel, and triggers a one-shot graph redraw.
  getControlValue(key) {
    // The picker always shows a concrete workspace, so report the resolved one
    // rather than a possibly empty stored name (see resolveWorkspaceName).
    if (key === 'workspaceName') return this.plugin.resolveWorkspaceName() ?? '';
    return this.plugin.settings[key];
  }

  async setControlValue(key, value) {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
  }

  getSettingDefinitions() {
    const names = this.plugin.listWorkspaceNames();
    const workspaceOptions = {};
    for (const name of names) workspaceOptions[name] = name;

    let workspaceDesc = 'Highlight the notes this workspace has open, without having to load it';
    if (names.length === 0) {
      workspaceOptions[''] = this.plugin.workspacesApi() ? 'No saved workspaces' : 'Workspaces plugin disabled';
      workspaceDesc = this.plugin.workspacesApi()
        ? 'No saved workspaces yet — save one from the Workspaces core plugin first.'
        : 'The Workspaces core plugin is disabled. Enable it under Settings → Core plugins to use this scope.';
    }

    return [
      {
        name: 'Enable',
        desc: 'Toggle highlighting on or off',
        control: { type: 'toggle', key: 'enabled' },
      },
      {
        name: 'Scope',
        desc: 'Which notes count as "open": those in every panel, only those in the active panel, or those stored in a saved workspace layout',
        control: {
          type: 'dropdown',
          key: 'scope',
          options: { all: 'All panels', panel: 'Active panel only', workspace: 'Saved workspace' },
        },
      },
      {
        name: 'Workspace',
        desc: workspaceDesc,
        visible: () => this.plugin.settings.scope === 'workspace',
        control: { type: 'dropdown', key: 'workspaceName', options: workspaceOptions },
      },
      {
        name: 'Open note color',
        desc: 'Color used to highlight open notes in the graph',
        control: { type: 'color', key: 'color' },
      },
      {
        name: 'Pinned note color',
        desc: 'Color used to highlight pinned notes in the graph',
        control: { type: 'color', key: 'pinnedColor' },
      },
      {
        name: 'Size multiplier',
        desc: 'How much larger open notes appear relative to the graph\'s node size setting (1 = same size, 2 = twice as large)',
        control: { type: 'slider', key: 'sizeMult', min: 1, max: 5, step: 0.2 },
      },
      {
        name: 'Dim opacity',
        desc: 'Opacity of non-open nodes (0 = invisible, 1 = normal)',
        control: { type: 'slider', key: 'dimOpacity', min: 0, max: 1, step: 0.05 },
      },
      {
        name: 'Highlight linked notes',
        desc: 'Also tint notes that are directly linked to an open or pinned note, using the same color at reduced opacity so they stay distinguishable',
        control: { type: 'toggle', key: 'highlightLinked' },
      },
      {
        name: 'Linked note opacity',
        desc: 'Color opacity used for linked notes (only relevant when "Highlight linked notes" is on)',
        visible: () => this.plugin.settings.highlightLinked,
        control: { type: 'slider', key: 'linkedOpacity', min: 0, max: 1, step: 0.05 },
      },
      {
        name: 'Highlight edges',
        desc: 'Tint edges connecting to an open or pinned note in that note\'s color, similar to Obsidian\'s native hover highlight',
        control: { type: 'toggle', key: 'highlightEdges' },
      },
      {
        name: 'Edge opacity',
        desc: 'Opacity of highlighted edges (only relevant when "Highlight edges" is on)',
        visible: () => this.plugin.settings.highlightEdges,
        control: { type: 'slider', key: 'edgeOpacity', min: 0, max: 1, step: 0.05 },
      },
    ];
  }

  // ── Imperative settings (Obsidian < 1.13) ──────────────────────────────────
  //
  // Built from the same definitions as the declarative tab, so each setting is
  // described once and both code paths cannot drift apart.

  display() {
    // On 1.13+ the tab is rendered from getSettingDefinitions() above; building
    // the controls here as well would show every setting twice.
    if (obsidian.requireApiVersion?.('1.13.0')) return;

    const { containerEl } = this;
    containerEl.empty();

    for (const def of this.getSettingDefinitions()) {
      if (def.visible && !def.visible()) continue;
      const { type, key } = def.control;
      const value = this.getControlValue(key);
      const onChange = async v => {
        await this.setControlValue(key, v);
        // These keys decide whether other settings are visible.
        if (RELAYOUT_KEYS.has(key)) this.display();
      };
      const setting = new obsidian.Setting(containerEl).setName(def.name).setDesc(def.desc);

      if (type === 'toggle') {
        setting.addToggle(c => c.setValue(value).onChange(onChange));
      } else if (type === 'color') {
        setting.addColorPicker(c => c.setValue(value).onChange(onChange));
      } else if (type === 'slider') {
        const { min, max, step } = def.control;
        setting.addSlider(c => c.setLimits(min, max, step).setValue(value).setDynamicTooltip().onChange(onChange));
      } else if (type === 'dropdown') {
        setting.addDropdown(c => c.addOptions(def.control.options).setValue(value).onChange(onChange));
      }
    }
  }
}

// ─── Main Plugin ─────────────────────────────────────────────────────────────

class OpenNotesHighlight extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.openPaths = new Set();    // paths of currently open (non-pinned) notes
    this.pinnedPaths = new Set();  // paths of currently pinned notes
    // Paths of notes directly linked (either direction) to an open/pinned note,
    // only populated when settings.highlightLinked is on. Maps path -> 'pinned'
    // or 'open', i.e. which kind of note it is linked to (pinned takes priority).
    this.linkedPaths = new Map();
    // Cache key for linkedPaths: the open/pinned sets plus _linksVersion, which
    // the metadata cache bumps whenever links change. Lets update() skip the
    // full scan over resolvedLinks when only focus moved. See computeLinkedPaths().
    this._linkedCacheKey = null;
    this._linksVersion = 0;
    // Every key a graph node id can take, mapped to its status ('pinned',
    // 'open', 'linked-pinned', 'linked-open'). Rebuilt by update(), so
    // node lookups are a single Map.get instead of a scan. See buildStatusIndex().
    this.statusIndex = new Map();
    // Highlight colors as integers, parsed once per change instead of once per
    // node (and per edge) per frame. See refreshColors().
    this._colorInt = 0;
    this._pinnedColorInt = 0;
    // Pending coalesced update, see requestUpdate().
    this._updateFrame = null;
    // Used for "active panel only" scope: the .workspace-tabs container element
    // of the most recently focused markdown leaf, plus its file path as a fallback
    // for the brief moment when the containerEl is detached from the DOM.
    this.activeGroupEl = null;
    this.activeLeafPath = null;
    // Cache for the parsed contents of a saved workspace layout, keyed by
    // workspace name + its mtime so it is rebuilt only when the user actually
    // saves that workspace. See refreshWorkspacePaths().
    this._wsCacheKey = null;
    this._wsCacheOpen = [];
    this._wsCachePinned = [];
    // Tracks which renderers already have our rAF loop attached, so we never
    // attach twice to the same renderer instance.
    this.patchedRenderers = new WeakSet();
    // Renderers belonging to currently open graph leaves; rebuilt on every
    // update(). The rAF loop of a renderer that dropped out of this set stops
    // itself, so closed graphs don't keep looping (and their renderer objects
    // aren't kept alive by our closures).
    this.liveRenderers = new Set();
    // One entry per open graph leaf; used to sync the in-graph control panel
    // when settings change from outside (e.g. the settings tab).
    this.graphPanels = [];
    // Flipped to false in onunload. The defineProperty getters installed on
    // PixiJS objects survive the plugin instance, so they must check this flag
    // and fall through to the original values once the plugin is disabled.
    this._active = true;
    // Generation counter for the per-node status cache; bumped on every
    // update() so cached statuses are invalidated whenever open/pinned/linked
    // sets or relevant settings may have changed.
    this._gen = 0;
  }

  hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  // Re-parses the highlight colors. Called from update() and directly by the
  // in-graph color pickers, which change the color live without saving.
  refreshColors() {
    this._colorInt = this.hexToInt(this.settings.color);
    this._pinnedColorInt = this.hexToInt(this.settings.pinnedColor);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.addCommand({
      id: 'toggle-highlighting',
      name: 'Toggle highlighting',
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings();
      },
    });

    // A single navigation usually fires layout-change, file-open and
    // active-leaf-change together; requestUpdate() folds them into one update.
    this.registerEvent(this.app.workspace.on('layout-change', () => this.requestUpdate()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.requestUpdate()));
    // Links changed somewhere in the vault: the linked-notes cache is stale.
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      this._linksVersion++;
      if (this.settings.highlightLinked) this.requestUpdate();
    }));
    // Note: querying the active view here instead of trusting the event's
    // leaf parameter — the parameter proved unreliable in earlier versions.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (view) {
        // Store the panel group element, not just the leaf, because the leaf
        // itself may move between panels (drag-and-drop) without firing this event again.
        this.activeGroupEl = view.containerEl?.closest('.workspace-tabs') ?? null;
        this.activeLeafPath = view.file?.path ?? null;
      }
      this.requestUpdate();
    }));

    this.app.workspace.onLayoutReady(() => {
      const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (view) {
        this.activeGroupEl = view.containerEl?.closest('.workspace-tabs') ?? null;
        this.activeLeafPath = view.file?.path ?? null;
      }
      this.update();
      // Graph renderers are initialised asynchronously after layout-ready.
      // Retry at increasing intervals to catch late-mounting graph leaves.
      [500, 1500, 4000].forEach(ms => {
        const id = window.setTimeout(() => this.requestUpdate(), ms);
        this.register(() => window.clearTimeout(id));
      });
    });
  }

  onunload() {
    // Deactivate the getters installed on PixiJS objects (they check _active),
    // restore each node's original color/weight, and force one redraw so the
    // graph returns to its normal appearance immediately.
    this._active = false;
    if (this._updateFrame !== null) cancelAnimationFrame(this._updateFrame);
    this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
      const renderer = leaf.view?.renderer;
      if (!renderer?.nodes) return;
      renderer.nodes.forEach(node => this.restoreNode(node));
      renderer.changed?.();
    });
  }

  // ── Core update cycle ──────────────────────────────────────────────────────

  update() {
    if (this._updateFrame !== null) {
      cancelAnimationFrame(this._updateFrame);
      this._updateFrame = null;
    }
    this._gen++; // invalidate the per-node/per-link status caches
    this.refreshColors();
    this.refreshOpenPaths();
    this.computeLinkedPaths();
    this.buildStatusIndex();
    this.handleGraphLeaves();
    this.syncPanels();
  }

  // Schedules update() for the next frame, folding any further requests until
  // then into the same run. Used for workspace events, which tend to arrive in
  // bursts; saveSettings() still calls update() directly because it needs the
  // result before triggering the redraw.
  requestUpdate() {
    if (this._updateFrame !== null) return;
    this._updateFrame = requestAnimationFrame(() => {
      this._updateFrame = null;
      if (this._active) this.update();
    });
  }

  // ── Saved workspaces ───────────────────────────────────────────────────────
  //
  // The Workspaces core plugin stores each saved workspace as a serialised
  // layout tree in .obsidian/workspaces.json and exposes them in memory via
  // its plugin instance. Reading those layouts lets us highlight the notes a
  // workspace has open *without* loading it — the graph stays where it is and
  // the user's current layout is untouched.
  //
  // This is unofficial API (app.internalPlugins), so every access is defensive:
  // if the core plugin is disabled or its shape ever changes, the feature
  // degrades to "no workspace found" instead of throwing.

  // Returns the Workspaces core plugin instance, or null when the plugin is
  // missing or disabled.
  workspacesApi() {
    const plugin = this.app.internalPlugins?.plugins?.workspaces;
    if (!plugin?.enabled) return null;
    const instance = plugin.instance;
    return instance?.workspaces ? instance : null;
  }

  // Names of all saved workspaces, alphabetically sorted. Empty when the core
  // plugin is unavailable or nothing has been saved yet.
  listWorkspaceNames() {
    const instance = this.workspacesApi();
    if (!instance) return [];
    return Object.keys(instance.workspaces).sort((a, b) => a.localeCompare(b));
  }

  // The workspace the user picked, falling back to whichever workspace the core
  // plugin currently has loaded and then to the first saved one. The last
  // fallback matters: the picker always displays *some* entry, so resolving to
  // the same one keeps the displayed selection and the highlighted notes in
  // agreement even before the user has chosen anything. Returns null only when
  // no saved workspace exists at all.
  resolveWorkspaceName() {
    const instance = this.workspacesApi();
    if (!instance) return null;
    const chosen = this.settings.workspaceName;
    if (chosen && instance.workspaces[chosen]) return chosen;
    const active = instance.activeWorkspace;
    if (active && instance.workspaces[active]) return active;
    return this.listWorkspaceNames()[0] ?? null;
  }

  // Depth-first walk over a serialised layout tree, invoking visit() for every
  // leaf. Layout nodes are 'split' / 'tabs' containers with a children array,
  // or 'leaf' endpoints; the same shape is used for the main area and both
  // sidebars.
  _walkLayout(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'leaf') { visit(node); return; }
    if (Array.isArray(node.children)) {
      for (const child of node.children) this._walkLayout(child, visit);
    }
  }

  // Fills openPaths / pinnedPaths from the selected saved workspace.
  //
  // Only markdown leaves are considered, matching what the live-leaf path does
  // (it filters on MarkdownView), so both scopes highlight the same kind of
  // node. A leaf's pinned flag is preserved, so pinned notes keep their own
  // color exactly as they do in the live scopes.
  refreshWorkspacePaths() {
    const name = this.resolveWorkspaceName();
    if (!name) return;
    const layout = this.workspacesApi().workspaces[name];

    // Layouts only change when the user saves a workspace, which bumps mtime —
    // so the walk result can be cached across the many update() calls that
    // ordinary editing triggers.
    const cacheKey = `${name}::${layout.mtime ?? 0}`;
    if (this._wsCacheKey !== cacheKey) {
      const open = [];
      const pinned = [];
      // Sidebars can hold markdown leaves too (e.g. a note dragged into the
      // right split), so all three roots are walked.
      for (const root of ['main', 'left', 'right']) {
        this._walkLayout(layout[root], leaf => {
          if (leaf.state?.type !== 'markdown') return;
          const file = leaf.state?.state?.file;
          if (!file) return;
          (leaf.pinned || leaf.state?.pinned ? pinned : open).push(file);
        });
      }
      this._wsCacheKey = cacheKey;
      this._wsCacheOpen = open;
      this._wsCachePinned = pinned;
    }

    for (const path of this._wsCacheOpen) this.openPaths.add(path);
    // Pinned wins if the same file somehow appears as both.
    for (const path of this._wsCachePinned) {
      this.openPaths.delete(path);
      this.pinnedPaths.add(path);
    }
  }

  // Rebuilds openPaths / pinnedPaths from all currently open markdown leaves,
  // respecting the configured scope.
  refreshOpenPaths() {
    this.openPaths.clear();
    this.pinnedPaths.clear();
    if (this.settings.scope === 'workspace') {
      this.refreshWorkspacePaths();
      return;
    }
    const panelOnly = this.settings.scope === 'panel';
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view instanceof obsidian.MarkdownView) {
        const file = leaf.view.file;
        if (!file?.path) return;
        if (panelOnly && this.activeGroupEl) {
          const leafGroupEl = leaf.containerEl?.closest('.workspace-tabs');
          // Allow the leaf whose path matches activeLeafPath as a fallback:
          // containerEl can briefly leave the DOM during panel rearrangements,
          // causing leafGroupEl to be null even though the leaf is still "active".
          if (leafGroupEl !== this.activeGroupEl && file.path !== this.activeLeafPath) return;
        }
        if (leaf.pinned) {
          this.pinnedPaths.add(file.path);
        } else {
          this.openPaths.add(file.path);
        }
      }
    });
  }

  // Rebuilds linkedPaths from Obsidian's metadata cache: any note that has a
  // resolved link (in either direction) to a currently open/pinned note gets
  // recorded here, tagged with whichever kind of note it is linked to ('pinned'
  // wins over 'open' if a note is linked to both). No-op unless the
  // "highlight linked notes" setting is on.
  computeLinkedPaths() {
    if (!this.settings.highlightLinked || (this.openPaths.size === 0 && this.pinnedPaths.size === 0)) {
      this.linkedPaths.clear();
      this._linkedCacheKey = null;
      return;
    }

    // The scan below touches every link in the vault. Most updates only move
    // focus without changing which notes are open, so skip it when neither the
    // open/pinned sets nor the vault's links have changed since the last run.
    const cacheKey = `${[...this.pinnedPaths].join('\n')}\0${[...this.openPaths].join('\n')}\0${this._linksVersion}`;
    if (cacheKey === this._linkedCacheKey) return;
    this._linkedCacheKey = cacheKey;
    this.linkedPaths.clear();

    const classify = path => this.pinnedPaths.has(path) ? 'pinned' : this.openPaths.has(path) ? 'open' : null;
    const addLinked = (path, kind) => {
      if (this.openPaths.has(path) || this.pinnedPaths.has(path)) return;
      if (this.linkedPaths.get(path) === 'pinned') return;
      this.linkedPaths.set(path, kind);
    };

    const resolvedLinks = this.app.metadataCache.resolvedLinks ?? {};
    for (const source in resolvedLinks) {
      const sourceKind = classify(source);
      const targets = resolvedLinks[source];
      for (const target in targets) {
        if (sourceKind) addLinked(target, sourceKind);
        const targetKind = classify(target);
        if (targetKind) addLinked(source, targetKind);
      }
    }
  }

  // Rebuilds statusIndex from the open, pinned and linked paths.
  //
  // Graph node IDs are typically the vault-relative file path, but can
  // sometimes be just the trailing part without its folder prefix, so every
  // suffix that starts after a '/' is indexed as well. Entries are added in
  // priority order and the first one wins: pinned before open before linked,
  // and among linked notes an exact path before a suffix — the order in which
  // the sets used to be searched node by node.
  buildStatusIndex() {
    const index = new Map();
    const setOnce = (key, status) => { if (!index.has(key)) index.set(key, status); };
    const addSuffixes = (path, status) => {
      for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
        setOnce(path.slice(i + 1), status);
      }
    };
    for (const path of this.pinnedPaths) { setOnce(path, 'pinned'); addSuffixes(path, 'pinned'); }
    for (const path of this.openPaths) { setOnce(path, 'open'); addSuffixes(path, 'open'); }
    for (const [path, kind] of this.linkedPaths) setOnce(path, `linked-${kind}`);
    for (const [path, kind] of this.linkedPaths) addSuffixes(path, `linked-${kind}`);
    this.statusIndex = index;
  }

  // Attaches our renderer loop and injects the control panel for every open
  // graph leaf that hasn't been set up yet.
  handleGraphLeaves() {
    this.liveRenderers = new Set();
    this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
      const renderer = leaf.view?.renderer;
      if (!renderer) return;
      this.liveRenderers.add(renderer);
      if (!this.patchedRenderers.has(renderer)) {
        this.patchedRenderers.add(renderer);
        this.attachToRenderer(renderer);
      }
      this.injectGraphPanel(leaf);
    });
  }

  // ── Node matching ──────────────────────────────────────────────────────────

  // Returns 'pinned', 'open', 'linked-pinned', 'linked-open', or null for a
  // given graph node. The 'linked-*' statuses only occur when highlightLinked
  // is enabled and the node is not itself open/pinned.
  //
  // This runs several times per node per frame (worldAlpha/worldTransform
  // getters plus applyToNode), so the result is cached on the node and only
  // looked up again when update() bumps the generation counter.
  getNodeStatus(node) {
    if (!this._active || !this.settings.enabled || !node?.id) return null;
    if (node._onhGen === this._gen) return node._onhStatus;
    const status = this.statusIndex.get(node.id) ?? null;
    node._onhGen = this._gen;
    node._onhStatus = status;
    return status;
  }

  // Only 'pinned' and 'open' nodes get the enlarged size — linked notes stay
  // at their normal size and are distinguished purely by color opacity.
  isSizedNode(node) {
    const status = this.getNodeStatus(node);
    return status === 'pinned' || status === 'open';
  }

  // ── PixiJS patching ────────────────────────────────────────────────────────

  // Patches the PixiJS display object (circle) of a graph node so that our
  // dimming and size overrides are applied at render time, every frame.
  //
  // Why Object.defineProperty instead of just assigning values each frame?
  //
  // PixiJS maintains a dirty-flag system: worldAlpha and worldTransform are
  // recomputed from parent values during the renderer's own update pass, which
  // runs before drawing. Any value we write gets overwritten before it is read.
  // By replacing these properties with getter/setter pairs, our logic runs at
  // the exact moment PixiJS reads the value for drawing — after its own update
  // pass — so our override always wins without interfering with the update logic.
  //
  // Re-patch detection: node.circle is replaced when Obsidian recycles or
  // recreates a node's display object. We store the current reference in
  // node._onhPatchedCircle and re-patch whenever it changes.
  patchNodeCircle(node) {
    if (!node.circle) return;
    if (node._onhPatchedCircle === node.circle) return;
    node._onhPatchedCircle = node.circle;
    const plugin = this;
    const circle = node.circle;

    // worldAlpha — controls the effective opacity used when drawing the circle.
    // We return our dimOpacity for non-matching nodes, or 1 for matching ones.
    // When the plugin is disabled or no notes are open we fall through to the
    // original value (stored in _worldAlpha by the setter) so the graph looks
    // completely normal.
    let _worldAlpha = circle.worldAlpha ?? 1;
    try {
      Object.defineProperty(circle, 'worldAlpha', {
        get() {
          if (!plugin._active || !plugin.settings.enabled || (plugin.openPaths.size === 0 && plugin.pinnedPaths.size === 0)) return _worldAlpha;
          const status = plugin.getNodeStatus(node);
          if (status === 'pinned' || status === 'open') return 1;
          if (status === 'linked-pinned' || status === 'linked-open') return plugin.settings.linkedOpacity;
          return plugin.settings.dimOpacity;
        },
        set(v) { _worldAlpha = v; },
        configurable: true, // allows re-patching if needed
        enumerable: false,
      });
    } catch(e) {}

    // worldTransform — a 2D affine matrix (PIXI.Matrix). The components a, b,
    // c, d encode rotation and scale (for axis-aligned nodes: a = scaleX,
    // d = scaleY, b = c = 0). By intercepting these we make the renderer draw
    // the node at fixedSize, regardless of what the physics simulation sets.
    //
    // We derive the override from the *parent's* worldTransform (the graph
    // canvas) multiplied by fixedSize. This keeps the scale in world-space
    // consistent as the user zooms in and out.
    const wt = circle.transform?.worldTransform;
    if (wt) {
      for (const k of ['a', 'b', 'c', 'd']) {
        let val = wt[k] ?? 0;
        try {
          Object.defineProperty(wt, k, {
            get() {
              if (plugin._active && plugin.settings.enabled && plugin.isSizedNode(node)) {
                return val * plugin.settings.sizeMult;
              }
              return val;
            },
            set(v) { val = v; },
            configurable: true,
            enumerable: true,
          });
        } catch(e) {}
      }
    }
  }

  // Returns 'pinned' or 'open' if either endpoint of the link is a pinned or
  // open note (pinned takes priority), or null if neither endpoint matches.
  // Cached per link per generation, like getNodeStatus — the _tintRGB and
  // worldAlpha getters call this every frame for every edge.
  getLinkColorKind(link) {
    if (link._onhGen === this._gen) return link._onhKind;
    const src = this.statusIndex.get(link.source?.id);
    const tgt = this.statusIndex.get(link.target?.id);
    let kind = null;
    if (src === 'pinned' || tgt === 'pinned') kind = 'pinned';
    else if (src === 'open' || tgt === 'open') kind = 'open';
    link._onhGen = this._gen;
    link._onhKind = kind;
    return kind;
  }

  // Patches the PixiJS sprite (link.line) used to draw an edge so that edges
  // touching an open/pinned note are tinted in that note's color — the same
  // effect Obsidian's own graph applies to edges of the currently hovered node
  // (see colors.lineHighlight in the core renderer), except keyed to our own
  // open/pinned sets instead of a single hover target, and permanent rather
  // than transient.
  //
  // Important: the PixiJS batch renderer never reads `sprite.tint` when
  // drawing — it reads `sprite._tintRGB`, a little-endian (0xBBGGRR) copy
  // that only the original `tint` setter keeps in sync. Intercepting `tint`
  // itself therefore has no visual effect (and worse, shadows the prototype
  // setter so `_tintRGB` stops updating entirely). So we intercept `_tintRGB`,
  // the value the renderer actually consumes at draw time.
  //
  // We also intercept `worldAlpha` so highlighted edges render at full
  // opacity, matching the native hover effect (which lifts connected edges
  // from the faded default to alpha 1).
  patchLinkLine(link) {
    const line = link.line;
    if (!line) return;
    if (link._onhPatchedLine === line && link._onhLineOwner === this) return;
    link._onhPatchedLine = line;
    link._onhLineOwner = this;
    const plugin = this;

    // Heal lines patched by a previous plugin version that shadowed `tint`:
    // deleting the own property restores the prototype accessor so Obsidian's
    // own tint writes reach _tintRGB again.
    if (Object.getOwnPropertyDescriptor(line, 'tint')) {
      try { delete line.tint; } catch(e) {}
    }

    const overrideColor = () => {
      if (!plugin._active || !plugin.settings.enabled || !plugin.settings.highlightEdges) return null;
      const kind = plugin.getLinkColorKind(link);
      if (!kind) return null;
      return kind === 'pinned' ? plugin._pinnedColorInt : plugin._colorInt;
    };

    let _tintRGB = line._tintRGB;
    try {
      Object.defineProperty(line, '_tintRGB', {
        get() {
          const c = overrideColor();
          if (c === null) return _tintRGB;
          // convert 0xRRGGBB to the little-endian 0xBBGGRR the batcher expects
          return ((c & 0xff) << 16) | (c & 0xff00) | (c >>> 16);
        },
        set(v) { _tintRGB = v; },
        configurable: true,
        enumerable: false,
      });
    } catch(e) {}

    let _worldAlpha = line.worldAlpha ?? 1;
    try {
      Object.defineProperty(line, 'worldAlpha', {
        get() {
          return overrideColor() === null ? _worldAlpha : plugin.settings.edgeOpacity;
        },
        set(v) { _worldAlpha = v; },
        configurable: true,
        enumerable: false,
      });
    } catch(e) {}
  }

  // Puts back the color and weight a node had before we highlighted it.
  restoreNode(node) {
    if (!node._onhSaved) return;
    node.color = node._onhOrigColor;
    node.weight = node._onhOrigWeight;
    delete node._onhSaved; delete node._onhOrigColor; delete node._onhOrigWeight;
  }

  // Applies color, size, and circle patches to a single node every frame.
  applyToNode(node) {
    if (!node) return;
    this.patchNodeCircle(node);
    const status = this.getNodeStatus(node); // null while disabled
    if (!status) {
      this.restoreNode(node);
      return;
    }
    if (!node._onhSaved) {
      node._onhSaved = true;
      node._onhOrigColor = node.color;
      node._onhOrigWeight = node.weight;
    }
    // 'linked-*' notes reuse the color of the note they're linked to; the
    // reduced opacity that sets them apart is applied via worldAlpha
    // (see patchNodeCircle), not here — node.color.a has no visible effect
    // on the renderer, only its rgb component does.
    const rgb = status === 'pinned' || status === 'linked-pinned' ? this._pinnedColorInt : this._colorInt;
    // Only written when it differs, so a steady graph doesn't allocate a new
    // color object per highlighted node per frame.
    if (node.color?.rgb !== rgb || node.color.a !== 1) node.color = { a: 1, rgb };
    // node.weight drives the node's physics body size and click target.
    // Scale by sizeMult² so the physics body matches the visual size.
    // Linked notes keep their original weight — only pinned/open are enlarged.
    const weight = status === 'pinned' || status === 'open'
      ? (node._onhOrigWeight || 1) * this.settings.sizeMult * this.settings.sizeMult
      : node._onhOrigWeight;
    if (node.weight !== weight) node.weight = weight;
  }

  // ── Renderer loop ──────────────────────────────────────────────────────────

  // Starts a requestAnimationFrame loop for the given renderer.
  //
  // Why rAF instead of reacting to workspace events?
  // The graph renderer runs its own rAF draw loop independently of Obsidian
  // events. New nodes can appear at any time (e.g. when links are followed or
  // the filter changes) and existing nodes get new circle objects without
  // warning. Polling every frame is the only reliable way to catch and patch
  // all of them. The per-frame cost is low: it is just a property read per
  // node, with no DOM access or layout thrashing.
  //
  // Note: renderer.changed() is called only on settings saves (see saveSettings),
  // NOT here. Calling it every frame re-triggers the physics simulation each
  // tick, causing the graph to jitter continuously.
  attachToRenderer(renderer) {
    const plugin = this;
    let frameId;
    // While highlighting is off, one pass per update is enough to restore the
    // nodes; after that the loop idles instead of walking every node each frame.
    let restoredGen = -1;
    const loop = () => {
      // Stop looping once the renderer's graph leaf is gone (liveRenderers is
      // rebuilt on every update, and closing a leaf fires layout-change).
      // Removing it from patchedRenderers releases our reference to it.
      if (!plugin.liveRenderers.has(renderer)) {
        plugin.patchedRenderers.delete(renderer);
        return;
      }
      const enabled = plugin.settings.enabled;
      const nodes = renderer.nodes;
      if (nodes && (enabled || restoredGen !== plugin._gen)) {
        nodes.forEach(node => plugin.applyToNode(node));
        restoredGen = enabled ? -1 : plugin._gen;
      }
      // Edges only need patching while edge highlighting is on; lines patched
      // earlier fall through to their original values when it is off.
      const links = renderer.links;
      if (links && enabled && plugin.settings.highlightEdges) links.forEach(link => plugin.patchLinkLine(link));
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    this.register(() => cancelAnimationFrame(frameId));
  }

  // ── In-graph control panel ─────────────────────────────────────────────────

  // Injects a floating control panel into a graph leaf's container element.
  // The panel is appended once per leaf and removed when the plugin unloads.
  // All static styling lives in styles.css (onh-* classes) so themes and
  // snippets can override it; JS only toggles state classes (is-collapsed,
  // onh-left, is-active).
  injectGraphPanel(leaf) {
    const container = leaf.view.containerEl;
    if (container.querySelector('.onh-panel')) return;

    container.classList.add('onh-graph-container');
    const panel = container.createDiv({ cls: 'onh-panel' });

    // Keeps the panel out of the way of Obsidian's own graph controls panel
    // (.graph-controls), which slides in from the right side of the graph view.
    // When collapsed the panel is always pinned to the left edge (see CSS).
    const reposition = () => {
      const gc = container.querySelector('.graph-controls');
      panel.classList.toggle('onh-left', !!(gc && gc.offsetWidth > 0));
    };
    // MutationObserver fires whenever the graph controls panel is shown or
    // hidden (class / style / childList change inside the container).
    const observer = new MutationObserver(reposition);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

    const setCollapsed = val => {
      panel.classList.toggle('is-collapsed', val);
      reposition();
    };

    // Collapsed state: slim tab pinned to the left edge; the expanded parts
    // (title row + content) are hidden via CSS while is-collapsed is set.
    const tabEl = panel.createDiv({ cls: 'onh-tab', text: '▶' });
    tabEl.addEventListener('click', () => setCollapsed(false));

    const titleRow = panel.createDiv({ cls: 'onh-title-row' });
    titleRow.createSpan({ cls: 'onh-title', text: 'Highlight' });
    titleRow.createSpan({ cls: 'onh-collapse-arrow', text: '◀' });
    titleRow.addEventListener('click', () => setCollapsed(true));

    const contentEl = panel.createDiv({ cls: 'onh-content' });

    reposition();

    // ── Control rows ──

    const enableToggle = this._toggleRow(contentEl, 'Enable', '', this.settings.enabled, async v => {
      this.settings.enabled = v; await this.saveSettings();
    });

    // Scope and its dependent workspace picker share one bordered group so the
    // divider stays below both, whether or not the picker is visible.
    const scopeGroup = contentEl.createDiv({ cls: 'onh-group onh-row-bb' });

    const scopeSelect = this._selectRow(scopeGroup, 'Scope', [
      { value: 'all', label: 'All panels' },
      { value: 'panel', label: 'Active panel' },
      { value: 'workspace', label: 'Workspace' },
    ], this.settings.scope, async v => {
      this.settings.scope = v;
      await this.saveSettings(); // syncPanels() shows/hides the picker below
    });

    const workspaceSelect = this._selectRow(scopeGroup, 'Workspace', [], this.settings.workspaceName, async v => {
      this.settings.workspaceName = v; await this.saveSettings();
    });

    const colorInput = this._colorRow(contentEl, 'Open', this.settings.color, v => {
      this.settings.color = v;
    });

    const pinnedColorInput = this._colorRow(contentEl, 'Pinned', this.settings.pinnedColor, v => {
      this.settings.pinnedColor = v;
    });

    const SIZE_STEPS = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5, 4, 5];
    const DIM_STEPS  = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.65, 0.8, 1];

    const sizeRow = this._stepRow(contentEl, 'Size ×', SIZE_STEPS, this.settings.sizeMult, async v => {
      this.settings.sizeMult = v; await this.saveSettings();
    });

    const dimRow = this._stepRow(contentEl, 'Dim', DIM_STEPS, this.settings.dimOpacity, async v => {
      this.settings.dimOpacity = v; await this.saveSettings();
    });

    const linkedToggle = this._toggleRow(contentEl, 'Highlight linked', 'onh-row-bt', this.settings.highlightLinked, async v => {
      this.settings.highlightLinked = v; await this.saveSettings();
    });

    const linkedOpacityRow = this._stepRow(contentEl, 'Link α', DIM_STEPS, this.settings.linkedOpacity, async v => {
      this.settings.linkedOpacity = v; await this.saveSettings();
    });

    const edgesToggle = this._toggleRow(contentEl, 'Highlight edges', '', this.settings.highlightEdges, async v => {
      this.settings.highlightEdges = v; await this.saveSettings();
    });

    const edgeOpacityRow = this._stepRow(contentEl, 'Edge α', DIM_STEPS, this.settings.edgeOpacity, async v => {
      this.settings.edgeOpacity = v; await this.saveSettings();
    });

    this.graphPanels.push({
      panel, enableToggle, scopeSelect, workspaceSelect, colorInput, pinnedColorInput, linkedToggle, edgesToggle,
      updateSize: sizeRow.update, updateDim: dimRow.update, updateLinkedOpacity: linkedOpacityRow.update,
      updateEdgeOpacity: edgeOpacityRow.update,
    });
    this.register(() => {
      observer.disconnect();
      panel.remove();
      container.classList.remove('onh-graph-container');
      this.graphPanels = this.graphPanels.filter(p => p.panel !== panel);
    });
  }

  // Builds a label + checkbox row. extraCls adds a divider variant
  // (onh-row-bb / onh-row-bt). Returns the checkbox element for syncPanels.
  _toggleRow(parent, label, extraCls, value, onChange) {
    const row = parent.createDiv({ cls: extraCls ? `onh-row ${extraCls}` : 'onh-row' });
    row.createSpan({ cls: 'onh-label', text: label });
    const input = row.createEl('input', { cls: 'onh-checkbox', type: 'checkbox' });
    input.checked = value;
    input.addEventListener('change', e => onChange(e.target.checked));
    return input;
  }

  // Builds a label + dropdown row. Returns { row, select, setOptions } —
  // setOptions(options, current) rebuilds the option list only when it actually
  // differs from what is already rendered, so the frequent syncPanels() calls
  // don't tear down and rebuild an open dropdown under the user's cursor.
  _selectRow(parent, label, options, value, onChange) {
    const row = parent.createDiv({ cls: 'onh-row' });
    row.createSpan({ cls: 'onh-label', text: label });
    const select = row.createEl('select', { cls: 'onh-select' });

    let signature = null;
    const setOptions = (opts, current) => {
      const next = opts.map(o => `${o.value}\u0001${o.label}`).join('\u0000');
      if (next !== signature) {
        signature = next;
        select.empty();
        for (const opt of opts) {
          const el = select.createEl('option', { text: opt.label });
          el.value = opt.value;
        }
      }
      if (current != null) select.value = current;
      // Fall back to the first entry when `current` isn't in the list (e.g. the
      // saved workspace was renamed), so the control never shows blank.
      if (select.selectedIndex < 0 && select.options.length > 0) select.selectedIndex = 0;
    };

    setOptions(options, value);
    select.addEventListener('change', e => onChange(e.target.value));
    return { row, select, setOptions };
  }

  // Builds a label + color-picker row. onSet is called live while dragging
  // ('input', applied by the rAF loop without saving); the final 'change'
  // additionally persists. Returns the input element for syncPanels.
  _colorRow(parent, label, value, onSet) {
    const row = parent.createDiv({ cls: 'onh-row' });
    row.createSpan({ cls: 'onh-label', text: label });
    const input = row.createEl('input', { cls: 'onh-color', type: 'color' });
    input.value = value;
    input.addEventListener('input', e => { onSet(e.target.value); this.refreshColors(); });
    input.addEventListener('change', async e => { onSet(e.target.value); await this.saveSettings(); });
    return input;
  }

  // Builds a row of discrete step buttons (used for the numeric values in the
  // panel). Returns { update(value) } so the row can be synced when settings change.
  _stepRow(parent, label, steps, currentValue, onSelect) {
    const wrapper = parent.createDiv({ cls: 'onh-steprow' });
    const top = wrapper.createDiv({ cls: 'onh-steprow-top' });
    top.createSpan({ cls: 'onh-label', text: label });
    const valDisplay = top.createSpan({ cls: 'onh-step-val' });

    const btnRow = wrapper.createDiv({ cls: 'onh-step-btns' });
    const buttons = steps.map(step => {
      const btn = btnRow.createEl('button', { cls: 'onh-step-btn' });
      btn.addEventListener('click', () => onSelect(step));
      return { btn, step };
    });

    const update = value => {
      const nearest = steps.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a);
      valDisplay.textContent = String(nearest);
      buttons.forEach(({ btn, step }) => btn.classList.toggle('is-active', step === nearest));
    };
    update(currentValue);
    return { update };
  }

  // Pushes current settings values into all open in-graph panels.
  // Called after any settings change so panels stay in sync even when the
  // change came from the settings tab rather than the panel itself.
  syncPanels() {
    // Drop entries whose panel left the DOM (its graph leaf was closed) so we
    // don't keep dead elements alive until the plugin unloads.
    this.graphPanels = this.graphPanels.filter(p => p.panel.isConnected);

    // Computed once for all panels: the workspace list can change at any time
    // (the user saves or deletes one) and is cheap but not free to build.
    const inWorkspaceScope = this.settings.scope === 'workspace';
    const workspaceNames = inWorkspaceScope ? this.listWorkspaceNames() : [];
    const workspaceOptions = workspaceNames.length > 0
      ? workspaceNames.map(name => ({ value: name, label: name }))
      : [{ value: '', label: this.workspacesApi() ? 'None saved' : 'Plugin off' }];
    const resolvedWorkspace = inWorkspaceScope ? this.resolveWorkspaceName() : null;

    for (const { enableToggle, scopeSelect, workspaceSelect, colorInput, pinnedColorInput, linkedToggle, edgesToggle, updateSize, updateDim, updateLinkedOpacity, updateEdgeOpacity } of this.graphPanels) {
      enableToggle.checked = this.settings.enabled;
      scopeSelect.select.value = this.settings.scope;
      workspaceSelect.row.classList.toggle('onh-hidden', !inWorkspaceScope);
      if (inWorkspaceScope) workspaceSelect.setOptions(workspaceOptions, resolvedWorkspace ?? '');
      colorInput.value = this.settings.color;
      pinnedColorInput.value = this.settings.pinnedColor;
      linkedToggle.checked = this.settings.highlightLinked;
      edgesToggle.checked = this.settings.highlightEdges;
      updateSize(this.settings.sizeMult);
      updateDim(this.settings.dimOpacity);
      updateLinkedOpacity(this.settings.linkedOpacity);
      updateEdgeOpacity(this.settings.edgeOpacity);
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  async loadSettings() {
    const saved = await this.loadData() ?? {};
    // Migrate from fixedSize (absolute) to sizeMult (multiplier)
    if (saved.fixedSize !== undefined && saved.sizeMult === undefined) {
      delete saved.fixedSize;
    }
    this.settings = Object.assign({}, DEFAULTS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.update();
    // Trigger a one-shot redraw so color / size changes are visible immediately.
    // This is intentionally called only here (on explicit user action), not in
    // the rAF loop — calling renderer.changed() every frame re-runs the physics
    // simulation each tick, which makes the graph jitter continuously.
    this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
      leaf.view?.renderer?.changed?.();
    });
  }
}

module.exports = OpenNotesHighlight;

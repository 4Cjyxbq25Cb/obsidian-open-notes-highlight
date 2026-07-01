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

var obsidian = require('obsidian');

// Default values for all persisted settings.
const DEFAULTS = {
  enabled: true,         // whether highlighting is active at all
  color: '#e06c75',      // highlight color for open (non-pinned) notes
  pinnedColor: '#61afef',// highlight color for pinned notes
  sizeMult: 2,           // multiplier applied to the graph's own node size
  dimOpacity: 0.15,      // opacity applied to non-highlighted nodes
  scope: 'all',          // 'all' = every panel, 'panel' = active panel only
  highlightLinked: false,// whether notes linked to an open/pinned note get tinted too
  linkedOpacity: 0.5,    // worldAlpha used for linked notes (open/pinned notes always use 1)
  highlightEdges: false, // whether edges touching an open/pinned note get tinted in its color
  edgeOpacity: 1,        // worldAlpha used for highlighted edges
};

// ─── Settings Tab ────────────────────────────────────────────────────────────

class SettingsTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Open Notes Graph Highlight' });

    new obsidian.Setting(containerEl)
      .setName('Enable')
      .setDesc('Toggle highlighting on or off')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async value => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Scope')
      .setDesc('Which panels to highlight notes from')
      .addDropdown(drop =>
        drop
          .addOption('all', 'All panels')
          .addOption('panel', 'Active panel only')
          .setValue(this.plugin.settings.scope)
          .onChange(async value => {
            this.plugin.settings.scope = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Open note color')
      .setDesc('Color used to highlight open notes in the graph')
      .addColorPicker(picker =>
        picker
          .setValue(this.plugin.settings.color)
          .onChange(async value => {
            this.plugin.settings.color = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Pinned note color')
      .setDesc('Color used to highlight pinned notes in the graph')
      .addColorPicker(picker =>
        picker
          .setValue(this.plugin.settings.pinnedColor)
          .onChange(async value => {
            this.plugin.settings.pinnedColor = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Size multiplier')
      .setDesc('How much larger open notes appear relative to the graph\'s node size setting (1 = same size, 2 = twice as large)')
      .addSlider(slider =>
        slider
          .setLimits(1, 5, 0.2)
          .setValue(this.plugin.settings.sizeMult)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.sizeMult = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Dim opacity')
      .setDesc('Opacity of non-open nodes (0 = invisible, 1 = normal)')
      .addSlider(slider =>
        slider
          .setLimits(0.0, 1.0, 0.05)
          .setValue(this.plugin.settings.dimOpacity)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.dimOpacity = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Highlight linked notes')
      .setDesc('Also tint notes that are directly linked to an open or pinned note, using the same color at reduced opacity so they stay distinguishable')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.highlightLinked)
          .onChange(async value => {
            this.plugin.settings.highlightLinked = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Linked note opacity')
      .setDesc('Color opacity used for linked notes (only relevant when "Highlight linked notes" is on)')
      .addSlider(slider =>
        slider
          .setLimits(0.0, 1.0, 0.05)
          .setValue(this.plugin.settings.linkedOpacity)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.linkedOpacity = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Highlight edges')
      .setDesc('Tint edges connecting to an open or pinned note in that note\'s color, similar to Obsidian\'s native hover highlight')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.highlightEdges)
          .onChange(async value => {
            this.plugin.settings.highlightEdges = value;
            await this.plugin.saveSettings();
          })
      );

    new obsidian.Setting(containerEl)
      .setName('Edge opacity')
      .setDesc('Opacity of highlighted edges (only relevant when "Highlight edges" is on)')
      .addSlider(slider =>
        slider
          .setLimits(0.0, 1.0, 0.05)
          .setValue(this.plugin.settings.edgeOpacity)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.edgeOpacity = value;
            await this.plugin.saveSettings();
          })
      );
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
    // Used for "active panel only" scope: the .workspace-tabs container element
    // of the most recently focused markdown leaf, plus its file path as a fallback
    // for the brief moment when the containerEl is detached from the DOM.
    this.activeGroupEl = null;
    this.activeLeafPath = null;
    // Tracks which renderers already have our rAF loop attached, so we never
    // attach twice to the same renderer instance.
    this.patchedRenderers = new WeakSet();
    // One entry per open graph leaf; used to sync the in-graph control panel
    // when settings change from outside (e.g. the settings tab).
    this.graphPanels = [];
  }

  hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerEvent(this.app.workspace.on('layout-change', () => this.update()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.update()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const active = this.app.workspace.activeLeaf;
      if (active?.view?.getViewType() === 'markdown') {
        // Store the panel group element, not just the leaf, because the leaf
        // itself may move between panels (drag-and-drop) without firing this event again.
        this.activeGroupEl = active.containerEl?.closest('.workspace-tabs') ?? null;
        this.activeLeafPath = active.view.file?.path ?? null;
      }
      this.update();
    }));

    this.app.workspace.onLayoutReady(() => {
      const active = this.app.workspace.activeLeaf;
      if (active?.view?.getViewType() === 'markdown') {
        this.activeGroupEl = active.containerEl?.closest('.workspace-tabs') ?? null;
        this.activeLeafPath = active.view.file?.path ?? null;
      }
      this.update();
      // Graph renderers are initialised asynchronously after layout-ready.
      // Retry at increasing intervals to catch late-mounting graph leaves.
      [500, 1500, 4000].forEach(ms => setTimeout(() => this.update(), ms));
    });
  }

  onunload() {
    this.graphPanels.forEach(({ panel }) => panel.remove());
    this.graphPanels = [];
  }

  // ── Core update cycle ──────────────────────────────────────────────────────

  update() {
    this.refreshOpenPaths();
    this.computeLinkedPaths();
    this.handleGraphLeaves();
    this.syncPanels();
  }

  // Rebuilds openPaths / pinnedPaths from all currently open markdown leaves,
  // respecting the configured scope.
  refreshOpenPaths() {
    this.openPaths.clear();
    this.pinnedPaths.clear();
    const panelOnly = this.settings.scope === 'panel';
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() === 'markdown') {
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
    this.linkedPaths.clear();
    if (!this.settings.highlightLinked) return;
    if (this.openPaths.size === 0 && this.pinnedPaths.size === 0) return;

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

  // Like _pathMatches, but for the path -> kind map used by linkedPaths.
  _linkedKind(nodeId) {
    if (this.linkedPaths.has(nodeId)) return this.linkedPaths.get(nodeId);
    for (const [p, kind] of this.linkedPaths) {
      if (p.endsWith('/' + nodeId)) return kind;
    }
    return null;
  }

  // Attaches our renderer loop and injects the control panel for every open
  // graph leaf that hasn't been set up yet.
  handleGraphLeaves() {
    this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
      const renderer = leaf.view?.renderer;
      if (!renderer) return;
      if (!this.patchedRenderers.has(renderer)) {
        this.patchedRenderers.add(renderer);
        this.attachToRenderer(renderer);
      }
      this.injectGraphPanel(leaf);
    });
  }

  // ── Node matching ──────────────────────────────────────────────────────────

  // Checks whether nodeId (as stored on a graph node) matches any path in the
  // given Set. Graph node IDs are typically the vault-relative file path, but
  // can sometimes be just the filename without its folder prefix, so we also
  // check whether any stored path ends with '/<nodeId>'.
  _pathMatches(paths, nodeId) {
    if (paths.has(nodeId)) return true;
    for (const p of paths) {
      if (p.endsWith('/' + nodeId) || p === nodeId) return true;
    }
    return false;
  }

  // Returns 'pinned', 'open', 'linked-pinned', 'linked-open', or null for a
  // given graph node. The 'linked-*' statuses only occur when highlightLinked
  // is enabled and the node is not itself open/pinned.
  getNodeStatus(node) {
    if (!this.settings.enabled || !node?.id) return null;
    if (this._pathMatches(this.pinnedPaths, node.id)) return 'pinned';
    if (this._pathMatches(this.openPaths, node.id)) return 'open';
    if (this.settings.highlightLinked) {
      const kind = this._linkedKind(node.id);
      if (kind) return `linked-${kind}`;
    }
    return null;
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
          if (!plugin.settings.enabled || (plugin.openPaths.size === 0 && plugin.pinnedPaths.size === 0)) return _worldAlpha;
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
              if (plugin.settings.enabled && plugin.isSizedNode(node)) {
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
  getLinkColorKind(link) {
    const srcId = link.source?.id;
    const tgtId = link.target?.id;
    if (this._pathMatches(this.pinnedPaths, srcId) || this._pathMatches(this.pinnedPaths, tgtId)) return 'pinned';
    if (this._pathMatches(this.openPaths, srcId) || this._pathMatches(this.openPaths, tgtId)) return 'open';
    return null;
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
      if (!plugin.settings.enabled || !plugin.settings.highlightEdges) return null;
      const kind = plugin.getLinkColorKind(link);
      if (!kind) return null;
      return plugin.hexToInt(kind === 'pinned' ? plugin.settings.pinnedColor : plugin.settings.color);
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

  // Applies color, size, and circle patches to a single node every frame.
  applyToNode(node) {
    if (!node) return;
    this.patchNodeCircle(node);
    if (!this.settings.enabled) {
      if (node._onhSaved) {
        node.color = node._onhOrigColor;
        node.weight = node._onhOrigWeight;
        delete node._onhSaved; delete node._onhOrigColor; delete node._onhOrigWeight;
      }
      return;
    }
    const status = this.getNodeStatus(node);
    if (status) {
      if (!node._onhSaved) {
        node._onhSaved = true;
        node._onhOrigColor = node.color;
        node._onhOrigWeight = node.weight;
      }
      // 'linked-*' notes reuse the color of the note they're linked to; the
      // reduced opacity that sets them apart is applied via worldAlpha
      // (see patchNodeCircle), not here — node.color.a has no visible effect
      // on the renderer, only its rgb component does.
      const isPinnedTone = status === 'pinned' || status === 'linked-pinned';
      const color = isPinnedTone ? this.settings.pinnedColor : this.settings.color;
      node.color = { a: 1, rgb: this.hexToInt(color) };
      // node.weight drives the node's physics body size and click target.
      // Scale by sizeMult² so the physics body matches the visual size.
      // Linked notes keep their original weight — only pinned/open are enlarged.
      node.weight = this.isSizedNode(node)
        ? (node._onhOrigWeight || 1) * this.settings.sizeMult * this.settings.sizeMult
        : node._onhOrigWeight;
    } else if (node._onhSaved) {
      node.color = node._onhOrigColor;
      node.weight = node._onhOrigWeight;
      delete node._onhSaved; delete node._onhOrigColor; delete node._onhOrigWeight;
    }
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
    const loop = () => {
      const nodes = renderer.nodes;
      if (nodes) nodes.forEach(node => plugin.applyToNode(node));
      const links = renderer.links;
      if (links) links.forEach(link => plugin.patchLinkLine(link));
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    this.register(() => cancelAnimationFrame(frameId));
  }

  // ── In-graph control panel ─────────────────────────────────────────────────

  // Injects a floating control panel into a graph leaf's container element.
  // The panel is appended once per leaf and removed when the plugin unloads.
  injectGraphPanel(leaf) {
    const container = leaf.view.containerEl;
    if (container.querySelector('.onh-panel')) return;

    const panel = document.createElement('div');
    panel.className = 'onh-panel';
    panel.style.cssText = [
      'position:absolute', 'bottom:100px', 'z-index:100',
      'background:var(--background-secondary)',
      'border:1px solid var(--background-modifier-border)',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'font-size:12px', 'display:flex', 'flex-direction:column',
    ].join(';');

    let collapsed = false;

    // Keeps the panel out of the way of Obsidian's own graph controls panel
    // (.graph-controls), which slides in from the right side of the graph view.
    // When collapsed the panel is always pinned to the left edge.
    const reposition = () => {
      if (collapsed) { panel.style.left = '0'; panel.style.right = ''; return; }
      const gc = container.querySelector('.graph-controls');
      const settingsOpen = gc && gc.offsetWidth > 0;
      panel.style.right = settingsOpen ? '' : '10px';
      panel.style.left = settingsOpen ? '10px' : '';
    };
    // MutationObserver fires whenever the graph controls panel is shown or
    // hidden (class / style / childList change inside the container).
    const observer = new MutationObserver(reposition);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

    // ── Collapsed state: slim tab pinned to the left edge ──
    // When collapsed the panel becomes a 26 px-wide strip with no left border
    // so it appears to emerge from the container's left wall.
    const tabEl = document.createElement('div');
    tabEl.textContent = '▶';
    tabEl.style.cssText = 'display:none;align-items:center;justify-content:center;cursor:pointer;color:var(--text-muted);font-size:11px;padding:10px 0;user-select:none;';
    tabEl.addEventListener('click', () => setCollapsed(false));
    panel.appendChild(tabEl);

    // ── Expanded state: full panel with title row and content ──
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:10px 12px 0;';
    const titleLbl = document.createElement('span');
    titleLbl.textContent = 'Highlight';
    titleLbl.style.cssText = 'font-weight:500;color:var(--text-normal);user-select:none;';
    const collapseArrow = document.createElement('span');
    collapseArrow.textContent = '◀';
    collapseArrow.style.cssText = 'font-size:9px;color:var(--text-muted);user-select:none;';
    titleRow.appendChild(titleLbl);
    titleRow.appendChild(collapseArrow);
    titleRow.addEventListener('click', () => setCollapsed(true));
    panel.appendChild(titleRow);

    const contentEl = document.createElement('div');
    contentEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:8px 12px 10px;margin-top:6px;border-top:1px solid var(--background-modifier-border);';
    panel.appendChild(contentEl);

    const setCollapsed = (val) => {
      collapsed = val;
      if (collapsed) {
        panel.style.minWidth = '';
        panel.style.width = '26px';
        panel.style.padding = '0';
        panel.style.borderRadius = '0 6px 6px 0';
        panel.style.borderLeft = 'none'; // flush with the container edge
        tabEl.style.display = 'flex';
        titleRow.style.display = 'none';
        contentEl.style.display = 'none';
      } else {
        panel.style.width = '';
        panel.style.minWidth = '190px';
        panel.style.padding = '0';
        panel.style.borderRadius = '6px';
        panel.style.borderLeft = '';
        tabEl.style.display = 'none';
        titleRow.style.display = 'flex';
        contentEl.style.display = 'flex';
      }
      reposition();
    };

    setCollapsed(false); // start expanded

    // ── Control rows ──

    const enableRow = document.createElement('div');
    enableRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const enableLbl = document.createElement('span');
    enableLbl.textContent = 'Enable';
    enableLbl.style.color = 'var(--text-muted)';
    const enableToggle = document.createElement('input');
    enableToggle.type = 'checkbox';
    enableToggle.checked = this.settings.enabled;
    enableToggle.style.cssText = 'width:16px;height:16px;cursor:pointer;';
    enableToggle.addEventListener('change', async e => {
      this.settings.enabled = e.target.checked;
      await this.saveSettings();
    });
    enableRow.appendChild(enableLbl);
    enableRow.appendChild(enableToggle);
    contentEl.appendChild(enableRow);

    const scopeRow = document.createElement('div');
    scopeRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-bottom:4px;border-bottom:1px solid var(--background-modifier-border);';
    const scopeLbl = document.createElement('span');
    scopeLbl.textContent = 'Active panel only';
    scopeLbl.style.color = 'var(--text-muted)';
    const scopeToggle = document.createElement('input');
    scopeToggle.type = 'checkbox';
    scopeToggle.checked = this.settings.scope === 'panel';
    scopeToggle.style.cssText = 'width:16px;height:16px;cursor:pointer;';
    scopeToggle.addEventListener('change', async e => {
      this.settings.scope = e.target.checked ? 'panel' : 'all';
      await this.saveSettings();
    });
    scopeRow.appendChild(scopeLbl);
    scopeRow.appendChild(scopeToggle);
    contentEl.appendChild(scopeRow);

    const colorRow = document.createElement('div');
    colorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const colorLbl = document.createElement('span');
    colorLbl.textContent = 'Open';
    colorLbl.style.color = 'var(--text-muted)';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = this.settings.color;
    colorInput.style.cssText = 'width:36px;height:22px;padding:0;border:none;cursor:pointer;background:none;';
    colorInput.addEventListener('input', e => { this.settings.color = e.target.value; });
    colorInput.addEventListener('change', async e => { this.settings.color = e.target.value; await this.saveSettings(); });
    colorRow.appendChild(colorLbl);
    colorRow.appendChild(colorInput);
    contentEl.appendChild(colorRow);

    const pinnedColorRow = document.createElement('div');
    pinnedColorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const pinnedColorLbl = document.createElement('span');
    pinnedColorLbl.textContent = 'Pinned';
    pinnedColorLbl.style.color = 'var(--text-muted)';
    const pinnedColorInput = document.createElement('input');
    pinnedColorInput.type = 'color';
    pinnedColorInput.value = this.settings.pinnedColor;
    pinnedColorInput.style.cssText = 'width:36px;height:22px;padding:0;border:none;cursor:pointer;background:none;';
    pinnedColorInput.addEventListener('input', e => { this.settings.pinnedColor = e.target.value; });
    pinnedColorInput.addEventListener('change', async e => { this.settings.pinnedColor = e.target.value; await this.saveSettings(); });
    pinnedColorRow.appendChild(pinnedColorLbl);
    pinnedColorRow.appendChild(pinnedColorInput);
    contentEl.appendChild(pinnedColorRow);

    const SIZE_STEPS = [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5, 4, 5];
    const DIM_STEPS  = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.65, 0.8, 1];

    const sizeRow = this._stepRow('Size ×', SIZE_STEPS, this.settings.sizeMult, async v => {
      this.settings.sizeMult = v; await this.saveSettings();
    });
    contentEl.appendChild(sizeRow.el);

    const dimRow = this._stepRow('Dim', DIM_STEPS, this.settings.dimOpacity, async v => {
      this.settings.dimOpacity = v; await this.saveSettings();
    });
    contentEl.appendChild(dimRow.el);

    const linkedRow = document.createElement('div');
    linkedRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-top:4px;border-top:1px solid var(--background-modifier-border);';
    const linkedLbl = document.createElement('span');
    linkedLbl.textContent = 'Highlight linked';
    linkedLbl.style.color = 'var(--text-muted)';
    const linkedToggle = document.createElement('input');
    linkedToggle.type = 'checkbox';
    linkedToggle.checked = this.settings.highlightLinked;
    linkedToggle.style.cssText = 'width:16px;height:16px;cursor:pointer;';
    linkedToggle.addEventListener('change', async e => {
      this.settings.highlightLinked = e.target.checked;
      await this.saveSettings();
    });
    linkedRow.appendChild(linkedLbl);
    linkedRow.appendChild(linkedToggle);
    contentEl.appendChild(linkedRow);

    const linkedOpacityRow = this._stepRow('Link α', DIM_STEPS, this.settings.linkedOpacity, async v => {
      this.settings.linkedOpacity = v; await this.saveSettings();
    });
    contentEl.appendChild(linkedOpacityRow.el);

    const edgesRow = document.createElement('div');
    edgesRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    const edgesLbl = document.createElement('span');
    edgesLbl.textContent = 'Highlight edges';
    edgesLbl.style.color = 'var(--text-muted)';
    const edgesToggle = document.createElement('input');
    edgesToggle.type = 'checkbox';
    edgesToggle.checked = this.settings.highlightEdges;
    edgesToggle.style.cssText = 'width:16px;height:16px;cursor:pointer;';
    edgesToggle.addEventListener('change', async e => {
      this.settings.highlightEdges = e.target.checked;
      await this.saveSettings();
    });
    edgesRow.appendChild(edgesLbl);
    edgesRow.appendChild(edgesToggle);
    contentEl.appendChild(edgesRow);

    const edgeOpacityRow = this._stepRow('Edge α', DIM_STEPS, this.settings.edgeOpacity, async v => {
      this.settings.edgeOpacity = v; await this.saveSettings();
    });
    contentEl.appendChild(edgeOpacityRow.el);

    container.style.position = 'relative';
    container.appendChild(panel);

    this.graphPanels.push({
      panel, enableToggle, scopeToggle, colorInput, pinnedColorInput, linkedToggle, edgesToggle,
      updateSize: sizeRow.update, updateDim: dimRow.update, updateLinkedOpacity: linkedOpacityRow.update,
      updateEdgeOpacity: edgeOpacityRow.update,
    });
    this.register(() => {
      observer.disconnect();
      panel.remove();
      this.graphPanels = this.graphPanels.filter(p => p.panel !== panel);
    });
  }

  // Builds a row of discrete step buttons (used for Size and Dim in the panel).
  // Returns { el, update(value) } so the row can be synced when settings change.
  _stepRow(label, steps, currentValue, onSelect) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:3px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.color = 'var(--text-muted)';
    const valDisplay = document.createElement('span');
    valDisplay.style.cssText = 'font-size:11px;min-width:28px;text-align:right;color:var(--text-muted);';
    top.appendChild(lbl);
    top.appendChild(valDisplay);
    wrapper.appendChild(top);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:2px;';
    const buttons = steps.map(step => {
      const btn = document.createElement('button');
      btn.style.cssText = 'flex:1;height:10px;border:none;border-radius:2px;cursor:pointer;padding:0;';
      btn.addEventListener('click', () => onSelect(step));
      btnRow.appendChild(btn);
      return { btn, step };
    });
    wrapper.appendChild(btnRow);

    const update = value => {
      const nearest = steps.reduce((a, b) => Math.abs(b - value) < Math.abs(a - value) ? b : a);
      valDisplay.textContent = nearest;
      buttons.forEach(({ btn, step }) => {
        btn.style.background = step === nearest
          ? 'var(--interactive-accent)'
          : 'var(--background-modifier-border)';
      });
    };
    update(currentValue);
    return { el: wrapper, update };
  }

  // Pushes current settings values into all open in-graph panels.
  // Called after any settings change so panels stay in sync even when the
  // change came from the settings tab rather than the panel itself.
  syncPanels() {
    for (const { enableToggle, scopeToggle, colorInput, pinnedColorInput, linkedToggle, edgesToggle, updateSize, updateDim, updateLinkedOpacity, updateEdgeOpacity } of this.graphPanels) {
      enableToggle.checked = this.settings.enabled;
      scopeToggle.checked = this.settings.scope === 'panel';
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

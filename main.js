'use strict';

var obsidian = require('obsidian');

const DEFAULTS = { color: '#e06c75', fixedSize: 8, dimOpacity: 0.15 };

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
      .setName('Highlight color')
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
      .setName('Node size')
      .setDesc('Fixed size of open notes in the graph (normal nodes: ~2–3)')
      .addSlider(slider =>
        slider
          .setLimits(1, 30, 0.5)
          .setValue(this.plugin.settings.fixedSize)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.fixedSize = value;
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
  }
}

class OpenNotesHighlight extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.openPaths = new Set();
    this.patchedRenderers = new WeakSet();
    this.graphPanels = [];
  }

  hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerEvent(this.app.workspace.on('layout-change', () => this.update()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.update()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.update()));

    this.app.workspace.onLayoutReady(() => this.update());
  }

  onunload() {
    this.graphPanels.forEach(({ panel }) => panel.remove());
    this.graphPanels = [];
  }

  update() {
    this.refreshOpenPaths();
    this.handleGraphLeaves();
    this.syncPanels();
  }

  refreshOpenPaths() {
    this.openPaths.clear();
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() === 'markdown') {
        const file = leaf.view.file;
        if (file?.path) this.openPaths.add(file.path);
      }
    });
  }

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

  nodeMatches(node) {
    if (!node?.id) return false;
    if (this.openPaths.has(node.id)) return true;
    for (const p of this.openPaths) {
      if (p.endsWith('/' + node.id) || p === node.id) return true;
    }
    return false;
  }

  patchNodeScale(node) {
    if (!node.circle?.scale) return;
    // Re-patch if node.circle was replaced with a new object
    if (node._onhPatchedScale === node.circle.scale) return;
    node._onhPatchedScale = node.circle.scale;
    const plugin = this;
    const scale = node.circle.scale;
    const circle = node.circle;

    // Intercept _x/_y backing fields (for initial sizing)
    for (const prop of ['_x', '_y']) {
      let val = scale[prop] ?? 0;
      try {
        Object.defineProperty(scale, prop, {
          get() { return plugin.nodeMatches(node) ? plugin.settings.fixedSize : val; },
          set(v) { val = v; },
          configurable: true, enumerable: false,
        });
      } catch(e) {}
    }

    // Patch updateTransform so worldTransform is corrected every render frame —
    // this is what makes slider changes apply in real-time (no dirty-flag dependency)
    if (typeof circle.updateTransform === 'function') {
      const origUT = circle.updateTransform.bind(circle);
      circle.updateTransform = function() {
        origUT();
        if (!plugin.nodeMatches(node)) return;
        const s = plugin.settings.fixedSize;
        const pWT = this.parent?.worldTransform;
        const wt = this.worldTransform;
        if (!pWT || !wt) return;
        // Rewrite worldTransform as parentTransform * uniformScale(fixedSize)
        wt.a = pWT.a * s;
        wt.b = pWT.b * s;
        wt.c = pWT.c * s;
        wt.d = pWT.d * s;
      };
    }
  }

  applyToNode(node, hasSomeOpen) {
    if (!node) return;
    const colorObj = { a: 1, rgb: this.hexToInt(this.settings.color) };
    const matches = this.nodeMatches(node);

    this.patchNodeScale(node);

    if (matches) {
      if (!node._onhSaved) {
        node._onhSaved = true;
        node._onhOrigColor = node.color;
        node._onhOrigWeight = node.weight;
      }
      node.color = colorObj;
      node.weight = this.settings.fixedSize * this.settings.fixedSize;
      node.fadeAlpha = 1;
      if (node.circle) node.circle.alpha = 1;
    } else {
      if (node._onhSaved) {
        node.color = node._onhOrigColor;
        node.weight = node._onhOrigWeight;
        delete node._onhSaved;
        delete node._onhOrigColor;
        delete node._onhOrigWeight;
      }
      if (hasSomeOpen) {
        node.fadeAlpha = this.settings.dimOpacity;
        if (node.circle) node.circle.alpha = this.settings.dimOpacity;
        node._onhDimmed = true;
      } else if (node._onhDimmed) {
        node.fadeAlpha = 1;
        if (node.circle) node.circle.alpha = 1;
        node._onhDimmed = false;
      }
    }
  }

  attachToRenderer(renderer) {
    const plugin = this;
    let frameId;
    const loop = () => {
      const nodes = renderer.nodes;
      const hasSomeOpen = plugin.openPaths.size > 0;
      if (nodes) nodes.forEach(node => plugin.applyToNode(node, hasSomeOpen));
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    this.register(() => cancelAnimationFrame(frameId));
  }

  injectGraphPanel(leaf) {
    const container = leaf.view.containerEl;
    if (container.querySelector('.onh-panel')) return;

    const panel = document.createElement('div');
    panel.className = 'onh-panel';
    panel.style.cssText = [
      'position:absolute', 'bottom:40px', 'right:10px',
      'background:var(--background-secondary)',
      'border:1px solid var(--background-modifier-border)',
      'border-radius:6px', 'padding:10px 12px', 'z-index:100',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'min-width:190px', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'font-size:12px',
    ].join(';');

    // color row
    const colorRow = document.createElement('div');
    colorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const colorLbl = document.createElement('span');
    colorLbl.textContent = 'Color';
    colorLbl.style.color = 'var(--text-muted)';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = this.settings.color;
    colorInput.style.cssText = 'width:36px;height:22px;padding:0;border:none;cursor:pointer;background:none;';
    colorInput.addEventListener('input', async e => {
      this.settings.color = e.target.value;
      await this.saveSettings();
    });
    colorRow.appendChild(colorLbl);
    colorRow.appendChild(colorInput);
    panel.appendChild(colorRow);

    // size slider
    const sizeVal = document.createElement('span');
    sizeVal.textContent = this.settings.fixedSize;
    sizeVal.style.cssText = 'font-size:11px;min-width:22px;text-align:right;color:var(--text-muted);';
    const sizeSlider = document.createElement('input');
    sizeSlider.type = 'range';
    sizeSlider.min = '1'; sizeSlider.max = '30'; sizeSlider.step = '0.5';
    sizeSlider.value = this.settings.fixedSize;
    sizeSlider.style.cssText = 'width:100%;margin:0;';
    sizeSlider.addEventListener('input', async e => {
      const v = parseFloat(e.target.value);
      sizeVal.textContent = v;
      this.settings.fixedSize = v;
      await this.saveSettings();
    });
    panel.appendChild(this._sliderRow('Size', sizeSlider, sizeVal));

    // dim opacity slider
    const dimVal = document.createElement('span');
    dimVal.textContent = this.settings.dimOpacity;
    dimVal.style.cssText = 'font-size:11px;min-width:22px;text-align:right;color:var(--text-muted);';
    const dimSlider = document.createElement('input');
    dimSlider.type = 'range';
    dimSlider.min = '0'; dimSlider.max = '1'; dimSlider.step = '0.05';
    dimSlider.value = this.settings.dimOpacity;
    dimSlider.style.cssText = 'width:100%;margin:0;';
    dimSlider.addEventListener('input', async e => {
      const v = parseFloat(e.target.value);
      dimVal.textContent = v;
      this.settings.dimOpacity = v;
      await this.saveSettings();
    });
    panel.appendChild(this._sliderRow('Dim', dimSlider, dimVal));

    container.style.position = 'relative';
    container.appendChild(panel);

    this.graphPanels.push({ panel, colorInput, sizeSlider, sizeVal, dimSlider, dimVal });
    this.register(() => {
      panel.remove();
      this.graphPanels = this.graphPanels.filter(p => p.panel !== panel);
    });
  }

  _sliderRow(label, slider, valEl) {
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.color = 'var(--text-muted)';
    top.appendChild(lbl);
    top.appendChild(valEl);
    wrapper.appendChild(top);
    wrapper.appendChild(slider);
    return wrapper;
  }

  syncPanels() {
    for (const { colorInput, sizeSlider, sizeVal, dimSlider, dimVal } of this.graphPanels) {
      colorInput.value = this.settings.color;
      sizeSlider.value = this.settings.fixedSize;
      sizeVal.textContent = this.settings.fixedSize;
      dimSlider.value = this.settings.dimOpacity;
      dimVal.textContent = this.settings.dimOpacity;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.update();
  }
}

module.exports = OpenNotesHighlight;

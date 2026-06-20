'use strict';

var obsidian = require('obsidian');

const DEFAULTS = { enabled: true, color: '#e06c75', fixedSize: 8, dimOpacity: 0.15 };

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
          .setLimits(1, 10, 0.5)
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

    this.app.workspace.onLayoutReady(() => {
      this.update();
      [500, 1500, 4000].forEach(ms => setTimeout(() => this.update(), ms));
    });
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
    if (!this.settings.enabled) return false;
    if (!node?.id) return false;
    if (this.openPaths.has(node.id)) return true;
    for (const p of this.openPaths) {
      if (p.endsWith('/' + node.id) || p === node.id) return true;
    }
    return false;
  }

  patchNodeCircle(node) {
    if (!node.circle) return;
    if (node._onhPatchedCircle === node.circle) return;
    node._onhPatchedCircle = node.circle;
    const plugin = this;
    const circle = node.circle;

    // Intercept worldAlpha so dimming applies at read-time, bypassing PixiJS dirty flags
    let _worldAlpha = circle.worldAlpha ?? 1;
    try {
      Object.defineProperty(circle, 'worldAlpha', {
        get() {
          if (!plugin.settings.enabled || plugin.openPaths.size === 0) return _worldAlpha;
          return plugin.nodeMatches(node) ? 1 : plugin.settings.dimOpacity;
        },
        set(v) { _worldAlpha = v; },
        configurable: true, enumerable: false,
      });
    } catch(e) {}

    // Intercept worldTransform matrix a/b/c/d so scale applies at read-time
    const wt = circle.transform?.worldTransform;
    if (wt) {
      for (const k of ['a', 'b', 'c', 'd']) {
        let val = wt[k] ?? 0;
        try {
          Object.defineProperty(wt, k, {
            get() {
              if (plugin.settings.enabled && plugin.nodeMatches(node)) {
                const pWT = circle.parent?.transform?.worldTransform;
                if (pWT) return pWT[k] * plugin.settings.fixedSize;
              }
              return val;
            },
            set(v) { val = v; },
            configurable: true, enumerable: true,
          });
        } catch(e) {}
      }
    }
  }

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
    const matches = this.nodeMatches(node);
    if (matches) {
      if (!node._onhSaved) {
        node._onhSaved = true;
        node._onhOrigColor = node.color;
        node._onhOrigWeight = node.weight;
      }
      node.color = { a: 1, rgb: this.hexToInt(this.settings.color) };
      node.weight = this.settings.fixedSize * this.settings.fixedSize;
    } else if (node._onhSaved) {
      node.color = node._onhOrigColor;
      node.weight = node._onhOrigWeight;
      delete node._onhSaved; delete node._onhOrigColor; delete node._onhOrigWeight;
    }
  }

  attachToRenderer(renderer) {
    const plugin = this;
    let frameId;
    const loop = () => {
      const nodes = renderer.nodes;
      if (nodes) nodes.forEach(node => plugin.applyToNode(node));
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
      'position:absolute', 'bottom:80px', 'right:10px',
      'background:var(--background-secondary)',
      'border:1px solid var(--background-modifier-border)',
      'border-radius:6px', 'padding:10px 12px', 'z-index:100',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'min-width:190px', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'font-size:12px',
    ].join(';');

    // enable toggle row
    const enableRow = document.createElement('div');
    enableRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding-bottom:6px;border-bottom:1px solid var(--background-modifier-border);';
    const enableLbl = document.createElement('span');
    enableLbl.textContent = 'Highlight';
    enableLbl.style.cssText = 'font-weight:500;color:var(--text-normal);';
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
    panel.appendChild(enableRow);

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
    colorInput.addEventListener('input', e => {
      this.settings.color = e.target.value;
    });
    colorInput.addEventListener('change', async e => {
      this.settings.color = e.target.value;
      await this.saveSettings();
    });
    colorRow.appendChild(colorLbl);
    colorRow.appendChild(colorInput);
    panel.appendChild(colorRow);

    const SIZE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const DIM_STEPS  = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.65, 0.8, 1];

    const sizeRow = this._stepRow('Size', SIZE_STEPS, this.settings.fixedSize, async v => {
      this.settings.fixedSize = v;
      await this.saveSettings();
    });
    panel.appendChild(sizeRow.el);

    const dimRow = this._stepRow('Dim', DIM_STEPS, this.settings.dimOpacity, async v => {
      this.settings.dimOpacity = v;
      await this.saveSettings();
    });
    panel.appendChild(dimRow.el);

    container.style.position = 'relative';
    container.appendChild(panel);

    this.graphPanels.push({ panel, enableToggle, colorInput, updateSize: sizeRow.update, updateDim: dimRow.update });
    this.register(() => {
      panel.remove();
      this.graphPanels = this.graphPanels.filter(p => p.panel !== panel);
    });
  }

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

  syncPanels() {
    for (const { enableToggle, colorInput, updateSize, updateDim } of this.graphPanels) {
      enableToggle.checked = this.settings.enabled;
      colorInput.value = this.settings.color;
      updateSize(this.settings.fixedSize);
      updateDim(this.settings.dimOpacity);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.update();
    this.app.workspace.getLeavesOfType('graph').forEach(leaf => {
      leaf.view?.renderer?.changed?.();
    });
  }
}

module.exports = OpenNotesHighlight;

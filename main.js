'use strict';

var obsidian = require('obsidian');

const DEFAULTS = { enabled: true, color: '#e06c75', pinnedColor: '#61afef', fixedSize: 8, dimOpacity: 0.15, scope: 'all' };

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
    this.pinnedPaths = new Set();
    this.activeGroupEl = null;
    this.activeLeafPath = null;
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
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const active = this.app.workspace.activeLeaf;
      if (active?.view?.getViewType() === 'markdown') {
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
    this.pinnedPaths.clear();
    const panelOnly = this.settings.scope === 'panel';
    this.app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view.getViewType() === 'markdown') {
        const file = leaf.view.file;
        if (!file?.path) return;
        if (panelOnly && this.activeGroupEl) {
          const leafGroupEl = leaf.containerEl?.closest('.workspace-tabs');
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

  _pathMatches(paths, nodeId) {
    if (paths.has(nodeId)) return true;
    for (const p of paths) {
      if (p.endsWith('/' + nodeId) || p === nodeId) return true;
    }
    return false;
  }

  getNodeStatus(node) {
    if (!this.settings.enabled || !node?.id) return null;
    if (this._pathMatches(this.pinnedPaths, node.id)) return 'pinned';
    if (this._pathMatches(this.openPaths, node.id)) return 'open';
    return null;
  }

  nodeMatches(node) {
    return this.getNodeStatus(node) !== null;
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
          if (!plugin.settings.enabled || (plugin.openPaths.size === 0 && plugin.pinnedPaths.size === 0)) return _worldAlpha;
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
    const status = this.getNodeStatus(node);
    if (status) {
      if (!node._onhSaved) {
        node._onhSaved = true;
        node._onhOrigColor = node.color;
        node._onhOrigWeight = node.weight;
      }
      const color = status === 'pinned' ? this.settings.pinnedColor : this.settings.color;
      node.color = { a: 1, rgb: this.hexToInt(color) };
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
      'position:absolute', 'bottom:100px',
      'background:var(--background-secondary)',
      'border:1px solid var(--background-modifier-border)',
      'border-radius:6px', 'padding:10px 12px', 'z-index:100',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'min-width:190px', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'font-size:12px',
    ].join(';');

    const reposition = () => {
      const gc = container.querySelector('.graph-controls');
      const settingsOpen = gc && gc.offsetWidth > 0;
      panel.style.right = settingsOpen ? '' : '10px';
      panel.style.left = settingsOpen ? '10px' : '';
    };
    reposition();
    const observer = new MutationObserver(reposition);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

    // title / collapse row
    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;cursor:pointer;';
    const titleLbl = document.createElement('span');
    titleLbl.textContent = 'Highlight';
    titleLbl.style.cssText = 'font-weight:500;color:var(--text-normal);user-select:none;';
    const collapseArrow = document.createElement('span');
    collapseArrow.textContent = '▲';
    collapseArrow.style.cssText = 'font-size:9px;color:var(--text-muted);user-select:none;';
    titleRow.appendChild(titleLbl);
    titleRow.appendChild(collapseArrow);
    panel.appendChild(titleRow);

    // collapsible content
    const contentEl = document.createElement('div');
    contentEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:6px;border-top:1px solid var(--background-modifier-border);padding-top:6px;';
    panel.appendChild(contentEl);

    let collapsed = false;
    titleRow.addEventListener('click', () => {
      collapsed = !collapsed;
      contentEl.style.display = collapsed ? 'none' : 'flex';
      collapseArrow.textContent = collapsed ? '▼' : '▲';
    });

    // enable toggle row
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

    // scope toggle row
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

    // open color row
    const colorRow = document.createElement('div');
    colorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const colorLbl = document.createElement('span');
    colorLbl.textContent = 'Open';
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
    contentEl.appendChild(colorRow);

    // pinned color row
    const pinnedColorRow = document.createElement('div');
    pinnedColorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    const pinnedColorLbl = document.createElement('span');
    pinnedColorLbl.textContent = 'Pinned';
    pinnedColorLbl.style.color = 'var(--text-muted)';
    const pinnedColorInput = document.createElement('input');
    pinnedColorInput.type = 'color';
    pinnedColorInput.value = this.settings.pinnedColor;
    pinnedColorInput.style.cssText = 'width:36px;height:22px;padding:0;border:none;cursor:pointer;background:none;';
    pinnedColorInput.addEventListener('input', e => {
      this.settings.pinnedColor = e.target.value;
    });
    pinnedColorInput.addEventListener('change', async e => {
      this.settings.pinnedColor = e.target.value;
      await this.saveSettings();
    });
    pinnedColorRow.appendChild(pinnedColorLbl);
    pinnedColorRow.appendChild(pinnedColorInput);
    contentEl.appendChild(pinnedColorRow);

    const SIZE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const DIM_STEPS  = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.65, 0.8, 1];

    const sizeRow = this._stepRow('Size', SIZE_STEPS, this.settings.fixedSize, async v => {
      this.settings.fixedSize = v;
      await this.saveSettings();
    });
    contentEl.appendChild(sizeRow.el);

    const dimRow = this._stepRow('Dim', DIM_STEPS, this.settings.dimOpacity, async v => {
      this.settings.dimOpacity = v;
      await this.saveSettings();
    });
    contentEl.appendChild(dimRow.el);

    container.style.position = 'relative';
    container.appendChild(panel);

    this.graphPanels.push({ panel, enableToggle, scopeToggle, colorInput, pinnedColorInput, updateSize: sizeRow.update, updateDim: dimRow.update });
    this.register(() => {
      observer.disconnect();
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
    for (const { enableToggle, scopeToggle, colorInput, pinnedColorInput, updateSize, updateDim } of this.graphPanels) {
      enableToggle.checked = this.settings.enabled;
      scopeToggle.checked = this.settings.scope === 'panel';
      colorInput.value = this.settings.color;
      pinnedColorInput.value = this.settings.pinnedColor;
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

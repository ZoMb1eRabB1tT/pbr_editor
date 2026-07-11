(function () {

    const PLUGIN_ID = 'zomb1es_pbr';
    const VERSION = '1.0.0';
    const STORAGE_KEY = 'zomb1es_pbr_presets';
    const FONT_SIZE_KEY = 'zomb1es_pbr_font_size';
    const THEME_KEY = 'zomb1es_pbr_theme';
    const CUSTOM_THEME_KEY = 'zomb1es_pbr_custom_theme';
    const SAVED_THEMES_KEY = 'zomb1es_pbr_saved_themes';

    const _actions = [];
    const _panels = [];
    const _styles = [];

    let texState = {};
    let activeTex = null;
    let lastUsedMode = 'mer';

    // ─── Layer helpers ──────────────────────────────────────────────────────────

    function getActiveLayer(tex) {
        if (!tex) return null;
        if (typeof tex.getActiveLayer === 'function') {
            try {
                const l = tex.getActiveLayer();
                if (l) return l;
            } catch (e) { /* fall through to other lookups below */ }
        }
        if (tex.layers && tex.layers.length) {
            return tex.layers.find(l => l.selected) || null;
        }
        if (tex.canvas) {
            return { canvas: tex.canvas, name: '__base__', uuid: tex.uuid + '_base', __isBaseTexture: true };
        }
        return null;
    }

    // ─── Channel detection from layer name ─────────────────────────────────────

    function getChannelFromLayerName(layerName) {
        if (!layerName) return null;
        const lower = layerName.toLowerCase();
        if (lower.includes('red') || lower.includes('metalness')) return 'm';
        if (lower.includes('green') || lower.includes('emissive')) return 'e';
        if (lower.includes('blue') || lower.includes('roughness')) return 'r';
        if (lower.includes('subsurface') || lower.includes('alpha') || lower.includes('sss')) return 's';
        return null;
    }

    // ─── State ──────────────────────────────────────────────────────────────────

    function defaultAdjustState() {
        return { hue: 0, saturation: 0, brightness: 0, contrast: 0 };
    }

    function defaultLayerState() {
        return {
            m_offset: 128, e_offset: 128, r_offset: 128, s_offset: 128,
            m_level: 100, e_level: 100, r_level: 100, s_level: 100,
            m_src: 'red', e_src: 'green', r_src: 'blue', s_src: 'value',
            _orig: null,
            _initialized: false,
            _adjust: defaultAdjustState(),
            _bakedSliders: null,
            _legacyNoOrigin: false
        };
    }

    function defaultTexMeta() {
        return { mode: 'mer', _modeManual: false };
    }

    function getTexMeta(uuid) {
        if (!texState[uuid]) texState[uuid] = {};
        if (!texState[uuid].__tex) texState[uuid].__tex = defaultTexMeta();
        return texState[uuid].__tex;
    }

    function getActiveLayerState(uuid) {
        if (!texState[uuid]) texState[uuid] = {};
        if (!texState[uuid].__layer) texState[uuid].__layer = defaultLayerState();
        return texState[uuid].__layer;
    }

    function stripMersSuffix(base) {
        return base.replace(/_mers?$/i, '');
    }

    // ─── Pixel math ──────────────────────────────────────────────────────────────

    const CH_INDEX = { m: 0, e: 1, r: 2, s: 3 };

    function clamp(v) { return Math.max(0, Math.min(255, Math.round(v))); }
    function toHex2(v) { return clamp(v).toString(16).padStart(2, '0'); }

    function pixelsEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    
    function isBlankCanvas(bytes) {
        for (let i = 0; i < bytes.length; i += 4) {
            if (bytes[i] !== 0 || bytes[i + 1] !== 0 || bytes[i + 2] !== 0 || bytes[i + 3] !== 0) {
                return false;
            }
        }
        return true;
    }

    function sourceFromPixel(r, g, b, mode) {
        r = r || 0; g = g || 0; b = b || 0;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        switch (mode) {
            case 'red': return r;
            case 'green': return g;
            case 'blue': return b;
            case 'value': return max;
            case 'brightness': return 0.299 * r + 0.587 * g + 0.114 * b;
            case 'saturation': return max === 0 ? 0 : ((max - min) / max) * 255;
            case 'hue': {
                if (max === min) return 0;
                let h;
                const d = max - min;
                if (max === r) h = ((g - b) / d) % 6;
                else if (max === g) h = (b - r) / d + 2;
                else h = (r - g) / d + 4;
                h = (h * 60) % 360;
                if (h < 0) h += 360;
                return (h / 360) * 255;
            }
            default: return r;
        }
    }

    function computeChannelValue(srcVal, level, offset) {
        const scale = level / 100;
        let val = srcVal * scale;
        val += (offset - 128);
        return clamp(val);
    }

    // ─── Image adjustments ─────────────────────────────────────────────────────

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const d = max - min;
        let h = 0;
        if (d !== 0) {
            if (max === r) h = ((g - b) / d) % 6;
            else if (max === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
            if (h < 0) h += 360;
        }
        const s = max === 0 ? 0 : d / max;
        const v = max;
        return [h, s, v];
    }

    function hsvToRgb(h, s, v) {
        const c = v * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = v - c;
        let r1, g1, b1;
        if (h < 60) [r1, g1, b1] = [c, x, 0];
        else if (h < 120) [r1, g1, b1] = [x, c, 0];
        else if (h < 180) [r1, g1, b1] = [0, c, x];
        else if (h < 240) [r1, g1, b1] = [0, x, c];
        else if (h < 300) [r1, g1, b1] = [x, 0, c];
        else[r1, g1, b1] = [c, 0, x];
        return [clamp((r1 + m) * 255), clamp((g1 + m) * 255), clamp((b1 + m) * 255)];
    }

    function applyContrastToChannel(v, contrast) {
        const c = Math.max(-100, Math.min(100, contrast));
        const factor = (259 * (c + 255)) / (255 * (259 - c));
        return clamp(factor * (v - 128) + 128);
    }

    function adjustPixelRGB(r, g, b, adj) {
        if (adj.brightness) {
            r = clamp(r + adj.brightness);
            g = clamp(g + adj.brightness);
            b = clamp(b + adj.brightness);
        }
        if (adj.contrast) {
            r = applyContrastToChannel(r, adj.contrast);
            g = applyContrastToChannel(g, adj.contrast);
            b = applyContrastToChannel(b, adj.contrast);
        }
        if (adj.hue || adj.saturation) {
            let [h, s, v] = rgbToHsv(r, g, b);
            h = (h + adj.hue + 360) % 360;
            s = Math.max(0, Math.min(1, s * (1 + adj.saturation / 100)));
            [r, g, b] = hsvToRgb(h, s, v);
        }
        return [r, g, b];
    }

    // ─── Core: compute final image ──────────────────────────────────────────────

    function computeFinalImageData(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return null;
        const meta = getTexMeta(uuid);
        const lSt = getActiveLayerState(uuid);
        const layer = getActiveLayer(tex);
        if (!layer || !layer.canvas) return null;
        captureOriginal(tex, layer, lSt);
        if (!lSt._orig) return null;

        const w = layer.canvas.width || tex.width || 16;
        const h = layer.canvas.height || tex.height || 16;
        let orig = lSt._orig;
        const adj = lSt._adjust || defaultAdjustState();

        const liveCtx = layer.canvas.getContext('2d');
        const live = liveCtx.getImageData(0, 0, w, h).data;

        if (orig.length !== live.length) {
            orig = new Uint8ClampedArray(live);
            lSt._orig = orig;
            lSt._origData = packOrigData(orig);
        }

        const chs = meta.mode === 'mers' ? ['m', 'e', 'r', 's'] : ['m', 'e', 'r'];
        const out = new Uint8ClampedArray(live.length);
        for (let i = 0; i < out.length; i++) out[i] = live[i];

        const activeChannel = window.Zomb1esPBR._activeChannel || null;

        for (const ch of chs) {
            if (activeChannel && activeChannel !== ch) continue;
            const idx = CH_INDEX[ch];
            const { offset, level, src } = getChannelValues(ch, lSt);
            for (let i = 0; i < out.length; i += 4) {
                if (live[i + 3] === 0) continue;
                const r = orig[i];
                const g = orig[i + 1];
                const b = orig[i + 2];
                const srcVal = sourceFromPixel(r, g, b, src);
                const finalVal = computeChannelValue(srcVal, level, offset);
                out[i + idx] = finalVal;
            }
        }

        for (let i = 0; i < out.length; i += 4) {
            if (live[i + 3] === 0) continue;
            const [r, g, b] = adjustPixelRGB(out[i], out[i + 1], out[i + 2], adj);
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
        }

        return new ImageData(out, w, h);
    }

    // ─── Get current channel values ─────────────────────────────────────────

    function getChannelValues(ch, lSt) {
        const defaultSrc = { m: 'red', e: 'green', r: 'blue', s: 'value' };
        if (!lSt) return { offset: 128, level: 100, src: defaultSrc[ch] || 'red' };
        return {
            offset: lSt[ch + '_offset'] ?? 128,
            level: lSt[ch + '_level'] ?? 100,
            src: lSt[ch + '_src'] || defaultSrc[ch] || 'red',
        };
    }

    // ─── Original pixel packing (for persistence) ─────────────────────────────

    function packOrigData(bytes) {
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    function unpackOrigData(str) {
        const binary = atob(str);
        const bytes = new Uint8ClampedArray(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // ─── Capture original pixels ───────────────────────────────────────────────

    function captureOriginal(tex, layer, lSt) {
        if (lSt._initialized) return;

        const stored = loadStateFromTexture(tex);
        let loadedFromStorage = false;

        if (stored && stored._origData) {
            try {
                const bytes = unpackOrigData(stored._origData);
                const w = layer.canvas.width || tex.width || 16;
                const h = layer.canvas.height || tex.height || 16;
                if (bytes.length === w * h * 4 && !isBlankCanvas(bytes)) {
                    lSt._orig = bytes;
                    lSt._origData = stored._origData;
                    lSt._initialized = true;
                    loadedFromStorage = true;
                }
            } catch (e) {
                // fall through
            }
        }

        if (!loadedFromStorage) {
            const ctx = layer.canvas.getContext('2d');
            const w = layer.canvas.width || tex.width || 16;
            const h = layer.canvas.height || tex.height || 16;
            const img = ctx.getImageData(0, 0, w, h);
            lSt._orig = new Uint8ClampedArray(img.data);
            lSt._origData = packOrigData(lSt._orig);
            lSt._initialized = true;
        }
    }

    // ─── Persistence helpers ──────────────────────────────────────────────────

    function saveStateToTexture(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return;
        const lSt = getActiveLayerState(uuid);
        if (!lSt) return;

        const state = {
            m_offset: lSt.m_offset ?? 128,
            e_offset: lSt.e_offset ?? 128,
            r_offset: lSt.r_offset ?? 128,
            s_offset: lSt.s_offset ?? 128,
            m_level: lSt.m_level ?? 100,
            e_level: lSt.e_level ?? 100,
            r_level: lSt.r_level ?? 100,
            s_level: lSt.s_level ?? 100,
            m_src: lSt.m_src || 'red',
            e_src: lSt.e_src || 'green',
            r_src: lSt.r_src || 'blue',
            s_src: lSt.s_src || 'value',
            _adjust: lSt._adjust || defaultAdjustState(),
            _mode: getTexMeta(uuid).mode || 'mer'
        };
        if (lSt._bakedSliders) {
            state._bakedSliders = lSt._bakedSliders;
        }
        if (lSt._origData) {
            state._origData = lSt._origData;
        }
        try {
            tex.zomb1es_pbr_state = JSON.stringify(state);
        } catch (e) {
            console.warn('[Zomb1es PBR] Failed to save state for texture', uuid, e);
        }
    }

    function loadStateFromTexture(tex) {
        if (!tex || !tex.zomb1es_pbr_state) return null;
        try {
            return JSON.parse(tex.zomb1es_pbr_state);
        } catch (e) {
            return null;
        }
    }

    // ─── Apply live to texture ─────────────────────────────────────────────────

    function applyLiveToTexture(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return;
        const layer = getActiveLayer(tex);
        if (!layer || !layer.canvas) return;
        const lSt = getActiveLayerState(uuid);
        captureOriginal(tex, layer, lSt);
        if (!lSt._orig) return;

        if (isBlankCanvas(lSt._orig)) {
            console.warn(`[Zomb1es PBR] Skipping apply – original pixels for texture ${uuid} are empty.`);
            window.Zomb1esPBR.updateUI(uuid);
            return;
        }

        const meta = getTexMeta(uuid);

        if (lSt._bakedSliders) {
            const current = {
                m_offset: lSt.m_offset ?? 128,
                e_offset: lSt.e_offset ?? 128,
                r_offset: lSt.r_offset ?? 128,
                s_offset: lSt.s_offset ?? 128,
                m_level: lSt.m_level ?? 100,
                e_level: lSt.e_level ?? 100,
                r_level: lSt.r_level ?? 100,
                s_level: lSt.s_level ?? 100
            };
            const baked = lSt._bakedSliders;
            const match = ['m', 'e', 'r', 's'].every(ch =>
                current[ch + '_offset'] === baked[ch + '_offset'] &&
                current[ch + '_level'] === baked[ch + '_level']
            );
            if (match) {
                window.Zomb1esPBR.updateUI(uuid);
                return;
            } else {
                delete lSt._bakedSliders;
            }
        }

        const imgData = computeFinalImageData(uuid);
        if (!imgData) return;

        const ctx = layer.canvas.getContext('2d');
        const current = ctx.getImageData(0, 0, imgData.width, imgData.height);

        if (!pixelsEqual(current.data, imgData.data)) {
            ctx.putImageData(imgData, 0, 0);

            if (!layer.__isBaseTexture && tex.updateLayerChanges) tex.updateLayerChanges(true);
            if (tex.updateChangesAfterEdit) tex.updateChangesAfterEdit();
            else if (typeof tex.update === 'function') tex.update();
            if (typeof Painter !== 'undefined' && Painter.current_texture === tex) Painter.refresh();
        }

        saveStateToTexture(uuid);
        window.Zomb1esPBR.updateUI(uuid);
    }

    // ─── Revert to original ────────────────────────────────────────────────────

    function revertTexture(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return;
        const lSt = getActiveLayerState(uuid);
        const layer = getActiveLayer(tex);
        if (!layer || !layer.canvas) return;
        if (!lSt._orig) return;

        delete lSt._bakedSliders;

        const w = layer.canvas.width || tex.width || 16;
        const h = layer.canvas.height || tex.height || 16;
        const ctx = layer.canvas.getContext('2d');
        const imgData = new ImageData(new Uint8ClampedArray(lSt._orig), w, h);
        ctx.putImageData(imgData, 0, 0);

        const defaultSrc = { m: 'red', e: 'green', r: 'blue', s: 'value' };
        ['m', 'e', 'r', 's'].forEach(ch => {
            lSt[ch + '_offset'] = 128;
            lSt[ch + '_level'] = 100;
            lSt[ch + '_src'] = defaultSrc[ch];
            const off = document.getElementById(`zom-offset-${ch}`);
            if (off) off.value = 128;
            const offVal = document.getElementById(`zom-offset-val-${ch}`);
            if (offVal) offVal.textContent = 128;
            const lev = document.getElementById(`zom-level-${ch}`);
            if (lev) lev.value = 100;
            const levVal = document.getElementById(`zom-level-val-${ch}`);
            if (levVal) levVal.textContent = 100;
            const srcEl = document.getElementById(`zom-src-${ch}`);
            if (srcEl) srcEl.value = defaultSrc[ch];
        });

        const adj = defaultAdjustState();
        lSt._adjust = adj;
        ['hue', 'sat', 'bri', 'con'].forEach(id => {
            const key = { hue: 'hue', sat: 'saturation', bri: 'brightness', con: 'contrast' }[id];
            const sl = document.getElementById(`zom-adj-${id}`);
            if (sl) sl.value = adj[key];
            const val = document.getElementById(`zom-adj-${id}-val`);
            if (val) val.textContent = adj[key];
        });

        if (!layer.__isBaseTexture && tex.updateLayerChanges) tex.updateLayerChanges(true);
        if (tex.updateChangesAfterEdit) tex.updateChangesAfterEdit();
        else if (typeof tex.update === 'function') tex.update();
        if (typeof Painter !== 'undefined' && Painter.current_texture === tex) Painter.refresh();

        saveStateToTexture(uuid);
        window.Zomb1esPBR.updateUI(uuid);
    }

    // ─── Duplicate with chosen mode ──────────────────────────────────────────

    function duplicateTextureWithMode(uuid, mode) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return;
        const suffix = mode === 'mers' ? '_mers' : '_mer';
        const imgData = computeFinalImageData(uuid);
        if (!imgData) return;

        const canvas = document.createElement('canvas');
        canvas.width = imgData.width;
        canvas.height = imgData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(imgData, 0, 0);

        const baseName = stripMersSuffix(tex.name.replace(/\.[a-zA-Z0-9]+$/, ''));
        const newName = baseName + suffix;
        const dataUrl = canvas.toDataURL('image/png');

        const groupId = tex.group || null;

        const newTex = new Texture({
            name: newName,
            saved: false,
            group: groupId,
            pbr_channel: 'mer'
        }).fromDataURL(dataUrl).add();

        if (groupId) newTex.group = groupId;
        newTex.pbr_channel = 'mer';

        const newMeta = getTexMeta(newTex.uuid);
        newMeta.mode = mode;
        newMeta._modeManual = true;

        const lSt = getActiveLayerState(uuid);
        const newLSt = getActiveLayerState(newTex.uuid);
        ['m', 'e', 'r', 's'].forEach(ch => {
            newLSt[ch + '_offset'] = lSt[ch + '_offset'] ?? 128;
            newLSt[ch + '_level'] = lSt[ch + '_level'] ?? 100;
            newLSt[ch + '_src'] = lSt[ch + '_src'] || (ch === 'm' ? 'red' : ch === 'e' ? 'green' : ch === 'r' ? 'blue' : 'value');
        });
        newLSt._adjust = { ...(lSt._adjust || defaultAdjustState()) };
        newLSt._orig = new Uint8ClampedArray(imgData.data);
        newLSt._origData = packOrigData(newLSt._orig);
        newLSt._initialized = true;
        newLSt._bakedSliders = {
            m_offset: lSt.m_offset ?? 128,
            e_offset: lSt.e_offset ?? 128,
            r_offset: lSt.r_offset ?? 128,
            s_offset: lSt.s_offset ?? 128,
            m_level: lSt.m_level ?? 100,
            e_level: lSt.e_level ?? 100,
            r_level: lSt.r_level ?? 100,
            s_level: lSt.s_level ?? 100
        };

        saveStateToTexture(newTex.uuid);

        if (typeof Blockbench.updateProjectTree === 'function') Blockbench.updateProjectTree();
        if (typeof Blockbench.updateInterface === 'function') Blockbench.updateInterface();
        if (typeof Blockbench.updateTexturePanel === 'function') Blockbench.updateTexturePanel();

        Blockbench.selectTexture(newTex);

        Blockbench.showQuickMessage(`Created ${newName} texture (${mode.toUpperCase()} channel).`);
    }

    function duplicateAsMer(uuid) {
        duplicateTextureWithMode(uuid, 'mer');
    }

    function duplicateAsMers(uuid) {
        duplicateTextureWithMode(uuid, 'mers');
    }

    // ─── Extract unique colors ────────────────────────────────────────────────

    function extractUniqueColors(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) {
            Blockbench.showQuickMessage('No texture selected.');
            return;
        }
        const layer = getActiveLayer(tex);
        if (!layer || !layer.canvas) {
            Blockbench.showQuickMessage('No active layer found.');
            return;
        }

        const ctx = layer.canvas.getContext('2d');
        const w = layer.canvas.width || tex.width || 16;
        const h = layer.canvas.height || tex.height || 16;
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        const colorMap = new Map();
        for (let i = 0; i < data.length; i += 4) {
            const a = data[i + 3];
            if (a === 0) continue;
            const key = `${data[i]},${data[i + 1]},${data[i + 2]},${a}`;
            const count = colorMap.get(key) || 0;
            colorMap.set(key, count + 1);
        }

        if (colorMap.size === 0) {
            Blockbench.showQuickMessage('No non-transparent colors found.');
            return;
        }

        const baseName = stripMersSuffix(tex.name.replace(/\.[a-zA-Z0-9]+$/, ''));
        const groupId = tex.group || null;

        let created = 0;
        for (const [key, count] of colorMap) {
            const [r, g, b, a] = key.split(',').map(Number);
            let hex = '#' + toHex2(r) + toHex2(g) + toHex2(b);
            if (a < 255) hex += toHex2(a);
            const colorName = hex.replace('#', '');
            const newName = baseName + '_color_' + colorName;

            const newCanvas = document.createElement('canvas');
            newCanvas.width = w;
            newCanvas.height = h;
            const nctx = newCanvas.getContext('2d');
            const outData = nctx.createImageData(w, h);
            const outPixels = outData.data;

            for (let i = 0; i < data.length; i += 4) {
                if (data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === a) {
                    outPixels[i] = r;
                    outPixels[i + 1] = g;
                    outPixels[i + 2] = b;
                    outPixels[i + 3] = a;
                } else {
                    outPixels[i] = 0;
                    outPixels[i + 1] = 0;
                    outPixels[i + 2] = 0;
                    outPixels[i + 3] = 0;
                }
            }
            nctx.putImageData(outData, 0, 0);

            const dataUrl = newCanvas.toDataURL('image/png');
            const newTex = new Texture({
                name: newName,
                saved: false,
                group: groupId || null
            }).fromDataURL(dataUrl).add();

            if (groupId) newTex.group = groupId;

            created++;
        }

        if (typeof Blockbench.updateProjectTree === 'function') Blockbench.updateProjectTree();
        if (typeof Blockbench.updateInterface === 'function') Blockbench.updateInterface();
        if (typeof Blockbench.updateTexturePanel === 'function') Blockbench.updateTexturePanel();
        Blockbench.showQuickMessage(`Extracted ${created} unique colors into separate textures.`);
    }

    // ─── Extract channels ──────────────────────────────────────────────────────

    function extractChannels(uuid) {
        const tex = Texture.all.find(t => t.uuid === uuid);
        if (!tex) return;
        const layer = getActiveLayer(tex);
        if (!layer || !layer.canvas) return;
        const lSt = getActiveLayerState(uuid);
        captureOriginal(tex, layer, lSt);
        if (!lSt._orig) return;

        const meta = getTexMeta(uuid);
        const chs = meta.mode === 'mers' ? ['m', 'e', 'r', 's'] : ['m', 'e', 'r'];
        const w = layer.canvas.width || tex.width || 16;
        const h = layer.canvas.height || tex.height || 16;

        const ctx = layer.canvas.getContext('2d');
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const baseName = stripMersSuffix(tex.name.replace(/\.[a-zA-Z0-9]+$/, ''));
        const groupId = tex.group || null;

        for (const ch of chs) {
            const idx = CH_INDEX[ch];
            const newCanvas = document.createElement('canvas');
            newCanvas.width = w;
            newCanvas.height = h;
            const nctx = newCanvas.getContext('2d');
            const outData = nctx.createImageData(w, h);
            const outPixels = outData.data;

            for (let i = 0; i < data.length; i += 4) {
                const val = data[i + idx];
                outPixels[i] = (idx === 0) ? val : 0;
                outPixels[i + 1] = (idx === 1) ? val : 0;
                outPixels[i + 2] = (idx === 2) ? val : 0;
                outPixels[i + 3] = (idx === 3) ? val : 255;
            }
            nctx.putImageData(outData, 0, 0);

            const suffix = '_' + ch.toUpperCase();
            const newName = baseName + suffix;
            const dataUrl = newCanvas.toDataURL('image/png');
            const newTex = new Texture({
                name: newName,
                saved: false,
                group: groupId || null
            }).fromDataURL(dataUrl).add();

            if (groupId) newTex.group = groupId;
        }

        if (typeof Blockbench.updateProjectTree === 'function') Blockbench.updateProjectTree();
        if (typeof Blockbench.updateInterface === 'function') Blockbench.updateInterface();
        if (typeof Blockbench.updateTexturePanel === 'function') Blockbench.updateTexturePanel();
        Blockbench.showQuickMessage(`Extracted ${chs.length} channels into their matching RGBA slots (M→R, E→G, R→B, S→A).`);
    }

    // ─── Find a layer by channel name ─────────────────────────────────────────

    function findLayerForChannel(tex, channel) {
        if (!tex || !tex.layers) return null;
        for (const layer of tex.layers) {
            if (!layer || !layer.name) continue;
            if (getChannelFromLayerName(layer.name) === channel) return layer;
        }
        return null;
    }

    // ─── Theme & Font size controls ───────────────────────────────────────────

    function getStoredFontSize() {
        try { return parseInt(localStorage.getItem(FONT_SIZE_KEY)) || 13; } catch { return 13; }
    }

    function getStoredTheme() {
        try { return localStorage.getItem(THEME_KEY) || 'default'; } catch { return 'default'; }
    }

    function getCustomTheme() {
        try {
            const raw = localStorage.getItem(CUSTOM_THEME_KEY);
            if (raw) return JSON.parse(raw);
        } catch { }
        return null;
    }

    function saveCustomTheme(theme) {
        try { localStorage.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme)); } catch { }
    }

    function applyTheme(theme) {
        const root = document.getElementById('zom-root');
        if (!root) return;
        root.classList.remove('zom-theme-default', 'zom-theme-light', 'zom-theme-dark', 'zom-theme-custom');
        const oldStyle = document.getElementById('zom-custom-theme-style');
        if (oldStyle) oldStyle.remove();

        if (theme === 'default') {
            root.classList.add('zom-theme-default');
            root.style.setProperty('--zom-bg', '');
            root.style.setProperty('--zom-bg-subtle', '');
            root.style.setProperty('--zom-text', '');
            root.style.setProperty('--zom-text-subtle', '');
            root.style.setProperty('--zom-border', '');
            root.style.setProperty('--zom-accent', '');
            root.style.setProperty('--zom-error', '');
            root.style.background = '';
        } else if (theme === 'light') {
            root.classList.add('zom-theme-light');
        } else if (theme === 'dark') {
            root.classList.add('zom-theme-dark');
        } else if (theme === 'custom') {
            root.classList.add('zom-theme-custom');
            const custom = getCustomTheme();
            if (custom) {
                const props = {
                    '--zom-bg': custom.bg || '#f5f5f5',
                    '--zom-bg-subtle': custom.bgSubtle || '#e8e8e8',
                    '--zom-text': custom.text || '#222',
                    '--zom-text-subtle': custom.textSubtle || '#555',
                    '--zom-border': custom.border || '#ccc',
                    '--zom-accent': custom.accent || '#0078d4',
                    '--zom-error': custom.error || '#f55'
                };
                for (const [key, val] of Object.entries(props)) {
                    root.style.setProperty(key, val);
                }
                if (custom.gradientEnabled && custom.gradientColor1 && custom.gradientColor2) {
                    const direction = custom.gradientDirection || 'to right';
                    const g = `linear-gradient(${direction}, ${custom.gradientColor1}, ${custom.gradientColor2})`;
                    root.style.background = g;
                } else {
                    root.style.background = props['--zom-bg'];
                }
            } else {
                const defaultCustom = {
                    bg: '#f5f5f5',
                    bgSubtle: '#e8e8e8',
                    text: '#222',
                    textSubtle: '#555',
                    border: '#ccc',
                    accent: '#0078d4',
                    error: '#f55',
                    gradientEnabled: false,
                    gradientDirection: 'to right',
                    gradientColor1: '#ff0000',
                    gradientColor2: '#0000ff'
                };
                saveCustomTheme(defaultCustom);
                applyTheme('custom');
                return;
            }
        }
        try { localStorage.setItem(THEME_KEY, theme); } catch { }
        document.querySelectorAll('.zom-theme-btn').forEach(btn => {
            btn.classList.toggle('zom-on', btn.dataset.theme === theme);
        });
        const editor = document.getElementById('zom-custom-theme-editor');
        if (editor) {
            editor.style.display = (theme === 'custom') ? 'block' : 'none';
            if (theme === 'custom') populateCustomThemeEditor();
        }
        applyFontSize(getStoredFontSize());
    }

    function populateCustomThemeEditor() {
        const custom = getCustomTheme() || {
            bg: '#f5f5f5',
            bgSubtle: '#e8e8e8',
            text: '#222',
            textSubtle: '#555',
            border: '#ccc',
            accent: '#0078d4',
            error: '#f55',
            gradientEnabled: false,
            gradientDirection: 'to right',
            gradientColor1: '#ff0000',
            gradientColor2: '#0000ff'
        };
        const fields = [
            { id: 'zom-custom-bg', label: 'Background', key: 'bg' },
            { id: 'zom-custom-bg-subtle', label: 'Bg Subtle', key: 'bgSubtle' },
            { id: 'zom-custom-text', label: 'Text', key: 'text' },
            { id: 'zom-custom-text-subtle', label: 'Text Subtle', key: 'textSubtle' },
            { id: 'zom-custom-border', label: 'Border', key: 'border' },
            { id: 'zom-custom-accent', label: 'Accent', key: 'accent' },
            { id: 'zom-custom-error', label: 'Error', key: 'error' }
        ];
        for (const f of fields) {
            const el = document.getElementById(f.id);
            if (el) el.value = custom[f.key] || '#ffffff';
        }
        const gradEl = document.getElementById('zom-custom-gradient-enabled');
        if (gradEl) gradEl.checked = !!custom.gradientEnabled;
        const dirEl = document.getElementById('zom-custom-gradient-dir');
        if (dirEl) dirEl.value = custom.gradientDirection || 'to right';
        const c1 = document.getElementById('zom-custom-gradient-color1');
        if (c1) c1.value = custom.gradientColor1 || '#ff0000';
        const c2 = document.getElementById('zom-custom-gradient-color2');
        if (c2) c2.value = custom.gradientColor2 || '#0000ff';
        toggleGradientOptions(!!custom.gradientEnabled);
        populateSavedThemesDropdown();
    }

    function toggleGradientOptions(show) {
        const opts = document.getElementById('zom-custom-gradient-options');
        if (opts) opts.style.display = show ? 'block' : 'none';
    }

    function updateCustomTheme() {
        const custom = {
            bg: document.getElementById('zom-custom-bg')?.value || '#f5f5f5',
            bgSubtle: document.getElementById('zom-custom-bg-subtle')?.value || '#e8e8e8',
            text: document.getElementById('zom-custom-text')?.value || '#222',
            textSubtle: document.getElementById('zom-custom-text-subtle')?.value || '#555',
            border: document.getElementById('zom-custom-border')?.value || '#ccc',
            accent: document.getElementById('zom-custom-accent')?.value || '#0078d4',
            error: document.getElementById('zom-custom-error')?.value || '#f55',
            gradientEnabled: document.getElementById('zom-custom-gradient-enabled')?.checked || false,
            gradientDirection: document.getElementById('zom-custom-gradient-dir')?.value || 'to right',
            gradientColor1: document.getElementById('zom-custom-gradient-color1')?.value || '#ff0000',
            gradientColor2: document.getElementById('zom-custom-gradient-color2')?.value || '#0000ff'
        };
        saveCustomTheme(custom);
        applyTheme('custom');
    }

    // ─── Saved Themes management ──────────────────────────────────────────────

    function getSavedThemes() {
        try {
            const raw = localStorage.getItem(SAVED_THEMES_KEY);
            if (raw) return JSON.parse(raw);
        } catch { }
        return [];
    }

    function saveThemeToLibrary(name) {
        if (!name || name.trim() === '') return Blockbench.showQuickMessage('Please enter a theme name.');
        const current = getCustomTheme();
        if (!current) return Blockbench.showQuickMessage('No custom theme to save.');
        const themes = getSavedThemes();
        const idx = themes.findIndex(t => t.name === name.trim());
        if (idx >= 0) {
            if (!confirm(`Theme "${name.trim()}" already exists. Overwrite?`)) return;
            themes[idx] = { name: name.trim(), data: current };
        } else {
            themes.push({ name: name.trim(), data: current });
        }
        localStorage.setItem(SAVED_THEMES_KEY, JSON.stringify(themes));
        populateSavedThemesDropdown();
        Blockbench.showQuickMessage(`Theme "${name.trim()}" saved.`);
    }

    function loadThemeFromLibrary(name) {
        const themes = getSavedThemes();
        const found = themes.find(t => t.name === name);
        if (found) {
            saveCustomTheme(found.data);
            applyTheme('custom');
            populateCustomThemeEditor();
            Blockbench.showQuickMessage(`Loaded theme "${name}".`);
        }
    }

    function deleteThemeFromLibrary(name) {
        if (!confirm(`Delete theme "${name}"?`)) return;
        let themes = getSavedThemes();
        themes = themes.filter(t => t.name !== name);
        localStorage.setItem(SAVED_THEMES_KEY, JSON.stringify(themes));
        populateSavedThemesDropdown();
        Blockbench.showQuickMessage(`Deleted theme "${name}".`);
    }

    function populateSavedThemesDropdown() {
        const select = document.getElementById('zom-saved-themes-select');
        if (!select) return;
        const themes = getSavedThemes();
        select.innerHTML = '<option value="">— Load saved —</option>';
        themes.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.name;
            opt.textContent = t.name;
            select.appendChild(opt);
        });
    }

    function applyFontSize(size) {
        const root = document.getElementById('zom-root');
        if (!root) return;
        root.style.fontSize = size + 'px';
        const oldStyle = document.getElementById('zom-font-size-override');
        if (oldStyle) oldStyle.remove();
        const style = document.createElement('style');
        style.id = 'zom-font-size-override';
        style.textContent = `
            #zom-root * {
                font-size: inherit !important;
            }
        `;
        root.appendChild(style);
        document.querySelectorAll('.zom-size-btn').forEach(btn => {
            btn.classList.toggle('zom-on', parseInt(btn.dataset.size) === size);
        });
        try { localStorage.setItem(FONT_SIZE_KEY, String(size)); } catch { }
    }

    // ─── Presets ──────────────────────────────────────────────────────────────────

    const BUILTIN_PRESETS = [
        { name: 'Oak log bark', m: 0, e: 0, r: 215, s: 50 },
        { name: 'Oak planks', m: 0, e: 0, r: 155, s: 80 },
        { name: 'Stripped log', m: 0, e: 0, r: 170, s: 85 },
        { name: 'Oak leaves', m: 0, e: 0, r: 180, s: 120 },
        { name: 'Stone', m: 0, e: 0, r: 200, s: 0 },
        { name: 'Polished stone', m: 0, e: 0, r: 100, s: 0 },
        { name: 'Wet stone', m: 0, e: 0, r: 80, s: 0 },
        { name: 'Iron block', m: 220, e: 0, r: 60, s: 0 },
        { name: 'Gold block', m: 255, e: 0, r: 80, s: 0 },
        { name: 'Glowing ember', m: 0, e: 180, r: 200, s: 0 },
        { name: 'Bioluminescent', m: 0, e: 120, r: 190, s: 90 },
        { name: 'Mushroom cap', m: 0, e: 0, r: 190, s: 100 },
    ];

    function loadUserPresets() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
    }
    function saveUserPresets(p) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { }
    }

    // ─── Info labels ────────────────────────────────────────────────────────────

    function metalInfo(v) {
        if (v === 0) return ['Non-metal', 'No metallic response.'];
        if (v < 64) return ['Trace metal', 'Faint tinted specular at glancing angles.'];
        if (v < 128) return ['Partial metal', 'Mixed response – painted metal.'];
        if (v < 200) return ['Metallic', 'Strong tinted specular, reflections carry albedo hue.'];
        return ['Pure metal', 'Full PBR metal. Albedo becomes tint only.'];
    }
    function emitInfo(v) {
        if (v === 0) return ['Off', 'No emission.'];
        if (v < 50) return ['Faint glow', 'Barely visible self-illumination.'];
        if (v < 120) return ['Glow', 'Visible emission – runes, fungi, embers.'];
        if (v < 200) return ['Bright glow', 'Strong self-lit, illuminates nearby geometry.'];
        return ['Full bloom', 'Maximum emission – lantern glass, lava inlay.'];
    }
    function roughInfo(v) {
        if (v <= 80) return ['Glossy', 'Mirror-like. Sharp specular, strong reflection.'];
        if (v <= 140) return ['Satin', 'Semi-gloss – lacquered wood, polished clay.'];
        if (v <= 200) return ['Matte', 'Flat diffuse – raw bark, dry stone.'];
        return ['Chalky', 'Fully diffuse – ash, chalk, dry soil.'];
    }
    function sssInfo(v) {
        if (v === 0) return ['None', 'No subsurface scatter.'];
        if (v < 60) return ['Trace SSS', 'Slight warmth at thin edges.'];
        if (v < 130) return ['Organic SSS', 'Noticeable scatter – planks, leaves, thin bark.'];
        if (v < 200) return ['Strong SSS', 'Heavy scatter. Glows visibly when backlit.'];
        return ['Max SSS', 'Translucent – mushroom caps, pale petals.'];
    }

    // ─── HTML ────────────────────────────────────────────────────────────────────

    function chBlock(ch, label, dot) {
        const srcOptions = ['red', 'green', 'blue', 'value', 'brightness', 'saturation', 'hue'];
        const srcLabels = {
            red: 'Red', green: 'Green', blue: 'Blue', value: 'Value',
            brightness: 'Brightness', saturation: 'Saturation', hue: 'Hue'
        };
        let srcHtml = `<select id="zom-src-${ch}" class="zom-src-select" style="font-size:inherit;background:var(--zom-bg-subtle);border:1px solid var(--zom-border);border-radius:3px;color:var(--zom-text);padding:1px 3px;">`;
        srcOptions.forEach(s => {
            const label2 = srcLabels[s] || s;
            const def = (ch === 'm' && s === 'red') || (ch === 'e' && s === 'green') || (ch === 'r' && s === 'blue') || (ch === 's' && s === 'value');
            srcHtml += `<option value="${s}" ${def ? 'selected' : ''}>${label2}</option>`;
        });
        srcHtml += `</select>`;

        return `
<div class="zom-ch-head">
  <div class="zom-dot" style="background:${dot}"></div>
  <span class="zom-ch-name" style="font-size:inherit;font-weight:600;color:var(--zom-text);flex:1;">${label}</span>
  <span id="zom-pill-${ch}" class="zom-pill" style="font-size:inherit;">—</span>
</div>
<div style="display:flex;gap:4px;align-items:center;margin-bottom:2px;flex-wrap:wrap;">
  <span style="font-size:inherit;color:var(--zom-text-subtle);">Source:</span>
  ${srcHtml}
  <span style="font-size:inherit;color:var(--zom-text-subtle);margin-left:4px;">Level:</span>
  <input type="range" min="0" max="200" value="100" step="1"
    id="zom-level-${ch}" class="zom-slider" style="flex:1;min-width:60px;accent-color:var(--zom-accent);"
    oninput="Zomb1esPBR.updateLevel('${ch}')">
  <span id="zom-level-val-${ch}" style="font-size:inherit;min-width:28px;text-align:center;">100</span>
</div>
<div style="display:flex;gap:4px;align-items:center;margin-bottom:2px;">
  <span style="font-size:inherit;color:var(--zom-text-subtle);">Offset (128=0):</span>
  <input type="range" min="0" max="255" value="128" step="1"
    id="zom-offset-${ch}" class="zom-slider" style="flex:1;accent-color:var(--zom-accent);"
    oninput="Zomb1esPBR.updateOffset('${ch}')">
  <span id="zom-offset-val-${ch}" style="font-size:inherit;min-width:28px;text-align:center;">128</span>
</div>
<p id="zom-desc-${ch}" class="zom-desc" style="font-size:inherit;margin:2px 0 0;color:var(--zom-text-subtle);">Scale & bias the source</p>
<div style="height:2px;background:var(--zom-border);margin:4px 0;"></div>`;
    }

    function adjSlider(id, label, min, max, val) {
        return `
<div style="display:flex;gap:4px;align-items:center;margin-bottom:3px;">
  <span style="font-size:inherit;color:var(--zom-text-subtle);width:64px;flex-shrink:0;">${label}</span>
  <input type="range" min="${min}" max="${max}" value="${val}" step="1"
    id="zom-adj-${id}" class="zom-slider" style="flex:1;accent-color:var(--zom-accent);"
    oninput="Zomb1esPBR.updateAdjust('${id}')">
  <span id="zom-adj-${id}-val" style="font-size:inherit;min-width:30px;text-align:center;">${val}</span>
</div>`;
    }

    function buildPanelHTML() {
        const currentSize = getStoredFontSize();
        const currentTheme = getStoredTheme();
        return `
<div id="zom-root" class="zom-theme-${currentTheme}" style="padding:8px;font-family:var(--font-main);font-size:${currentSize}px;
  color:var(--zom-text);overflow-y:auto;height:100%;
  max-height:calc(100vh - 150px);box-sizing:border-box;
  background:var(--zom-bg);">

  <div id="zom-empty" style="text-align:center;padding:24px 8px;
    color:var(--zom-text-subtle);font-size:12px">
    Select a texture to configure PBR channels
  </div>

  <div id="zom-editor" style="display:none">
    <div id="zom-pbr-enabled" style="display:none">

      <!-- Header -->
      <div style="display:flex;justify-content:space-between;align-items:center;
        margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--zom-border);position:relative;">
        <span style="font-size:inherit;font-weight:600;color:var(--zom-text-subtle)">
          Zomb1es PBR — Live Edit & Generate
        </span>
        <div style="display:flex;align-items:center;gap:4px;">
          <!-- Mode Toggle -->
          <div style="display:flex;border:1px solid var(--zom-border);border-radius:4px;overflow:hidden;">
            <button id="zom-mode-mer" class="zom-modbtn zom-on" style="font-size:inherit;padding:2px 6px;border:none;background:transparent;color:var(--zom-text-subtle);cursor:pointer;" onclick="Zomb1esPBR.setMode('mer')">MER</button>
            <button id="zom-mode-mers" class="zom-modbtn" style="font-size:inherit;padding:2px 6px;border:none;background:transparent;color:var(--zom-text-subtle);cursor:pointer;" onclick="Zomb1esPBR.setMode('mers')">MERS</button>
          </div>
          <!-- Settings gear -->
          <div style="position:relative;display:inline-block;">
            <button id="zom-settings-toggle" class="zom-btn-sm" style="font-size:18px;padding:0 4px;line-height:1;border:1px solid var(--zom-border);color:var(--zom-text);">⚙</button>
            <div id="zom-settings-popup" style="display:none;position:absolute;right:0;top:100%;margin-top:4px;
              background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;
              padding:10px 14px;z-index:100;min-width:280px;max-height:80vh;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
              <div style="font-size:inherit;font-weight:600;color:var(--zom-text-subtle);margin-bottom:6px;">Text Size</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">
                <button class="zom-size-btn ${currentSize === 11 ? 'zom-on' : ''}" data-size="11" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setFontSize(11)">Small</button>
                <button class="zom-size-btn ${currentSize === 13 ? 'zom-on' : ''}" data-size="13" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setFontSize(13)">Medium</button>
                <button class="zom-size-btn ${currentSize === 16 ? 'zom-on' : ''}" data-size="16" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setFontSize(16)">Large</button>
              </div>
              <div style="font-size:inherit;font-weight:600;color:var(--zom-text-subtle);margin-bottom:6px;">Color Theme</div>
              <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
                <button class="zom-theme-btn ${currentTheme === 'default' ? 'zom-on' : ''}" data-theme="default" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setTheme('default')">Default</button>
                <button class="zom-theme-btn ${currentTheme === 'light' ? 'zom-on' : ''}" data-theme="light" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setTheme('light')">Light</button>
                <button class="zom-theme-btn ${currentTheme === 'dark' ? 'zom-on' : ''}" data-theme="dark" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setTheme('dark')">Dark</button>
                <button class="zom-theme-btn ${currentTheme === 'custom' ? 'zom-on' : ''}" data-theme="custom" style="font-size:inherit;padding:2px 8px;border-radius:4px;border:1px solid var(--zom-border);background:transparent;color:var(--zom-text);cursor:pointer;" onclick="Zomb1esPBR.setTheme('custom')">Custom</button>
              </div>
              <!-- Custom Theme Editor -->
              <div id="zom-custom-theme-editor" style="display:${currentTheme === 'custom' ? 'block' : 'none'};border-top:1px solid var(--zom-border);padding-top:6px;margin-top:4px;">
                <div style="font-size:inherit;font-weight:600;color:var(--zom-text-subtle);margin-bottom:4px;">Edit Custom Theme</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
                  ${['bg', 'bg-subtle', 'text', 'text-subtle', 'border', 'accent', 'error'].map(id => {
            const label = id.replace('-', ' ').replace(/^./, s => s.toUpperCase());
            return `<label style="font-size:inherit;color:var(--zom-text-subtle);">${label}: <input type="color" id="zom-custom-${id}" value="#ffffff" style="width:100%;" onchange="Zomb1esPBR.updateCustomTheme()"></label>`;
        }).join('')}
                </div>
                <div style="margin-top:4px;">
                  <label style="font-size:inherit;color:var(--zom-text-subtle);display:flex;align-items:center;gap:4px;">
                    <input type="checkbox" id="zom-custom-gradient-enabled" onchange="Zomb1esPBR.toggleGradientOptions(this.checked);Zomb1esPBR.updateCustomTheme();"> Enable Gradient
                  </label>
                </div>
                <div id="zom-custom-gradient-options" style="display:none;margin-top:4px;">
                  <div style="display:flex;gap:4px;align-items:center;">
                    <span style="font-size:inherit;color:var(--zom-text-subtle);">Direction:</span>
                    <select id="zom-custom-gradient-dir" style="font-size:inherit;background:var(--zom-bg-subtle);border:1px solid var(--zom-border);color:var(--zom-text);" onchange="Zomb1esPBR.updateCustomTheme()">
                      <option value="to right">→</option>
                      <option value="to left">←</option>
                      <option value="to bottom">↓</option>
                      <option value="to top">↑</option>
                      <option value="to bottom right">↘</option>
                      <option value="to bottom left">↙</option>
                      <option value="to top right">↗</option>
                      <option value="to top left">↖</option>
                    </select>
                  </div>
                  <div style="display:flex;gap:4px;margin-top:2px;">
                    <label style="font-size:inherit;color:var(--zom-text-subtle);">Color 1: <input type="color" id="zom-custom-gradient-color1" value="#ff0000" onchange="Zomb1esPBR.updateCustomTheme()"></label>
                    <label style="font-size:inherit;color:var(--zom-text-subtle);">Color 2: <input type="color" id="zom-custom-gradient-color2" value="#0000ff" onchange="Zomb1esPBR.updateCustomTheme()"></label>
                  </div>
                </div>
                <!-- Theme Library -->
                <div style="margin-top:8px;border-top:1px solid var(--zom-border);padding-top:6px;">
                  <div style="font-size:inherit;font-weight:600;color:var(--zom-text-subtle);margin-bottom:4px;">Saved Themes</div>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;">
                    <input id="zom-save-theme-name" type="text" style="font-size:inherit;padding:2px 4px;background:var(--zom-bg-subtle);border:1px solid var(--zom-border);border-radius:3px;color:var(--zom-text);flex:1;min-width:60px;" placeholder="Theme name">
                    <button class="zom-btn-sm" style="font-size:inherit;padding:2px 6px;" onclick="Zomb1esPBR.saveTheme()">Save</button>
                  </div>
                  <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;">
                    <select id="zom-saved-themes-select" style="font-size:inherit;background:var(--zom-bg-subtle);border:1px solid var(--zom-border);border-radius:3px;color:var(--zom-text);flex:1;" onchange="Zomb1esPBR.loadTheme(this.value)">
                      <option value="">— Load saved —</option>
                    </select>
                    <button class="zom-btn-sm" style="font-size:inherit;padding:2px 6px;border-color:var(--zom-error,#f55);color:var(--zom-error,#f55);" onclick="Zomb1esPBR.deleteTheme()">Delete</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Channels Section -->
      <div class="zom-card" style="background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;padding:8px 10px;margin-bottom:0;">
        <div class="zom-sec" style="font-size:inherit;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--zom-text-subtle);margin-bottom:2px;">Channels — Source → Level → Offset</div>
        <div class="zom-desc" style="font-size:inherit;color:var(--zom-text-subtle);margin-bottom:6px;line-height:1.4;">
          For each PBR channel, choose a source (Red/Green/Blue/Value/Brightness/Saturation/Hue), adjust Level (0-200%) and Offset (0-255, 128=neutral). 
          Changes update the texture and 3D view live.
        </div>
        <div id="zom-channel-m">${chBlock('m', 'Metalness', '#e55')}</div>
        <div id="zom-channel-e">${chBlock('e', 'Emissive', '#5c5')}</div>
        <div id="zom-channel-r">${chBlock('r', 'Roughness', '#55e')}</div>
        <div id="zom-channel-s" style="display:none;">${chBlock('s', 'Subsurface', '#fa5')}</div>
        <div style="display:flex;gap:5px;margin-top:4px;flex-wrap:wrap;">
          <button class="zom-btn-sm" style="font-size:inherit;padding:3px 9px;border:1px solid var(--zom-error,#f55);border-radius:4px;color:var(--zom-error,#f55);cursor:pointer;background:transparent;" onclick="Zomb1esPBR.revertTexture()">Reset to Original</button>
        </div>
        <div style="font-size:inherit;color:var(--zom-text-subtle);margin-top:4px;">
          "Reset to Original" clears all adjustments and reverts the texture to its saved state.
        </div>
      </div>

      <!-- Image Adjustments -->
      <div class="zom-card" style="margin-top:6px;background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;padding:8px 10px;">
        <div class="zom-sec" style="font-size:inherit;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--zom-text-subtle);margin-bottom:2px;">Image Adjustments</div>
        ${adjSlider('hue', 'Hue', -180, 180, 0)}
        ${adjSlider('sat', 'Saturation', -100, 100, 0)}
        ${adjSlider('bri', 'Brightness', -100, 100, 0)}
        ${adjSlider('con', 'Contrast', -100, 100, 0)}
        <button class="zom-btn-sm" style="font-size:inherit;padding:3px 9px;border:1px solid var(--zom-border);border-radius:4px;color:var(--zom-text);cursor:pointer;background:transparent;" onclick="Zomb1esPBR.resetAdjust()">Reset Adjustments</button>
      </div>

      <!-- Extract / Actions -->
      <div class="zom-card" style="margin-top:6px;background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;padding:8px 10px;">
        <div class="zom-sec" style="font-size:inherit;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--zom-text-subtle);margin-bottom:2px;">Extract / Actions</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="zom-btn-sm zom-btn-acc" onclick="Zomb1esPBR.extractChannels()">Extract Channels</button>
          <button class="zom-btn-sm zom-btn-acc" onclick="Zomb1esPBR.extractColors()">Extract Colors</button>
          <button class="zom-btn-sm" onclick="Zomb1esPBR.duplicateAsMer()">Duplicate as MER</button>
          <button class="zom-btn-sm" onclick="Zomb1esPBR.duplicateAsMers()">Duplicate as MERS</button>
        </div>
        <div style="font-size:inherit;color:var(--zom-text-subtle);margin-top:4px;">
          Settings are automatically saved inside each texture – no external files needed.
        </div>
      </div>

      <!-- Presets -->
      <div class="zom-card" style="margin-top:6px;background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;padding:8px 10px;">
        <div class="zom-sec" style="font-size:inherit;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--zom-text-subtle);margin-bottom:2px;">Presets</div>
        <div id="zom-presets" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px"></div>
        <div style="display:flex;gap:5px">
          <input id="zom-preset-name" type="text" class="zom-inp" placeholder="Preset name…" style="flex:1;">
          <button class="zom-btn-sm zom-btn-acc" onclick="Zomb1esPBR.savePreset()">Save</button>
        </div>
      </div>

      <!-- Preview Swatch -->
      <div class="zom-card" style="margin-top:6px;background:var(--zom-bg);border:1px solid var(--zom-border);border-radius:6px;padding:8px 10px;">
        <div class="zom-sec" style="font-size:inherit;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--zom-text-subtle);margin-bottom:2px;">Preview Swatch</div>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <canvas id="zom-swatch" width="96" height="96" style="width:64px;height:64px;border-radius:4px;border:1px solid var(--zom-border);image-rendering:pixelated;"></canvas>
          <div style="flex:1">
            <div id="zom-finish" style="font-weight:600;">—</div>
            <div id="zom-finish-sub" style="color:var(--zom-text-subtle);"></div>
            <code id="zom-hex" style="color:var(--zom-text-subtle);display:block;"></code>
            <div id="zom-debug" style="color:var(--zom-text-subtle);font-family:monospace;"></div>
          </div>
        </div>
        <div id="zom-chan-select" style="display:flex;gap:3px;margin-top:8px;flex-wrap:wrap">
          <button class="zom-chbtn zom-on" data-ch="composite" onclick="Zomb1esPBR.setPreviewChannel('composite')">Composite</button>
          <button class="zom-chbtn" data-ch="m" onclick="Zomb1esPBR.setPreviewChannel('m')">Metalness</button>
          <button class="zom-chbtn" data-ch="e" onclick="Zomb1esPBR.setPreviewChannel('e')">Emissive</button>
          <button class="zom-chbtn" data-ch="r" onclick="Zomb1esPBR.setPreviewChannel('r')">Roughness</button>
          <button class="zom-chbtn" id="zom-chbtn-s" data-ch="s" onclick="Zomb1esPBR.setPreviewChannel('s')">Subsurface</button>
        </div>
      </div>

    </div><!-- end zom-pbr-enabled -->
  </div><!-- end zom-editor -->
</div>`;
    }

    // ─── CSS ──────────────────────────────────────────────────────────────────────

    function injectStyles() {
        if (document.getElementById('zom-styles')) return;
        const css = `
#zom-root {
  --zom-bg: var(--color-back);
  --zom-bg-subtle: var(--color-back-subtle);
  --zom-text: var(--color-text);
  --zom-text-subtle: var(--color-text-subtle);
  --zom-border: var(--color-border);
  --zom-accent: var(--color-accent);
  --zom-error: #f55;
  background: var(--zom-bg);
  color: var(--zom-text);
}
#zom-root.zom-theme-light {
  --zom-bg: #f5f5f5;
  --zom-bg-subtle: #e8e8e8;
  --zom-text: #222;
  --zom-text-subtle: #555;
  --zom-border: #ccc;
  --zom-accent: #0078d4;
}
#zom-root.zom-theme-dark {
  --zom-bg: #1e1e1e;
  --zom-bg-subtle: #2d2d2d;
  --zom-text: #e0e0e0;
  --zom-text-subtle: #aaa;
  --zom-border: #444;
  --zom-accent: #4c9aff;
}
.zom-card {
  background: var(--zom-bg);
  border: 1px solid var(--zom-border);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 0;
}
.zom-sec {
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
  color: var(--zom-text-subtle);
  margin-bottom: 2px;
}
.zom-desc {
  color: var(--zom-text-subtle);
  margin-bottom: 6px;
  line-height: 1.4;
}
.zom-ch-head {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 1px;
}
.zom-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.zom-ch-name {
  font-weight: 600;
  color: var(--zom-text);
  flex: 1;
}
.zom-slider {
  width: 100%;
  margin: 1px 0 2px;
  accent-color: var(--zom-accent);
}
.zom-pill {
  padding: 1px 6px;
  border-radius: 20px;
  font-weight: 600;
  white-space: nowrap;
}
.zom-pill-off  { background: var(--zom-bg-subtle); color: var(--zom-text-subtle); }
.zom-pill-warn { background: #4a3500; color: #f0a800; }
.zom-pill-green { background: #1a3a1a; color: #4eb84e; }
.zom-pill-blue { background: #1a2a4a; color: #5a9ef0; }
.zom-inp {
  padding: 3px 7px;
  background: var(--zom-bg-subtle);
  border: 1px solid var(--zom-border);
  border-radius: 4px;
  color: var(--zom-text);
  flex: 1;
  min-width: 0;
  outline: none;
}
.zom-inp:focus { border-color: var(--zom-accent); }
.zom-btn-sm {
  padding: 3px 9px;
  background: transparent;
  border: 1px solid var(--zom-border);
  border-radius: 4px;
  color: var(--zom-text);
  cursor: pointer;
  white-space: nowrap;
}
.zom-btn-sm:hover { background: var(--zom-bg-subtle); }
.zom-btn-acc { border-color: var(--zom-accent); color: var(--zom-accent); }
.zom-modbtn {
  padding: 3px 9px;
  background: transparent;
  border: none;
  color: var(--zom-text-subtle);
  cursor: pointer;
}
.zom-modbtn.zom-on { background: var(--zom-accent); color: #fff; }
.zom-pbtn {
  padding: 2px 7px;
  border-radius: 20px;
  border: 1px solid var(--zom-border);
  background: var(--zom-bg-subtle);
  color: var(--zom-text-subtle);
  cursor: pointer;
}
.zom-pbtn:hover { color: var(--zom-text); }
.zom-pbtn.zom-user { border-style: dashed; }
.zom-chbtn {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--zom-border);
  background: transparent;
  color: var(--zom-text-subtle);
  cursor: pointer;
}
.zom-chbtn:hover { color: var(--zom-text); }
.zom-chbtn.zom-on { background: var(--zom-accent); color: #fff; border-color: var(--zom-accent); }
.zom-src-select {
  background: var(--zom-bg-subtle);
  border: 1px solid var(--zom-border);
  border-radius: 3px;
  color: var(--zom-text);
  padding: 1px 3px;
}
.zom-size-btn, .zom-theme-btn {
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--zom-border);
  background: transparent;
  color: var(--zom-text);
  cursor: pointer;
}
.zom-size-btn:hover, .zom-theme-btn:hover { background: var(--zom-bg-subtle); }
.zom-size-btn.zom-on, .zom-theme-btn.zom-on { background: var(--zom-accent); color: #fff; border-color: var(--zom-accent); }
`;
        const el = document.createElement('style');
        el.id = 'zom-styles'; el.textContent = css;
        document.head.appendChild(el);
        _styles.push(el);
    }

    // ─── Controller ─────────────────────────────────────────────────────────────

    window.Zomb1esPBR = {
        _popupBound: false,
        _previewChannel: 'composite',
        _selectionMode: 'texture',
        _activeChannel: null,

        activate(uuid) {
            activeTex = uuid;
            this._selectionMode = 'texture';
            this._activeChannel = null;
            this._loadState(uuid);
            document.getElementById('zom-empty')?.style.setProperty('display', 'none');
            document.getElementById('zom-editor')?.style.setProperty('display', '');
            this.render();
            const size = getStoredFontSize();
            applyFontSize(size);
            const theme = getStoredTheme();
            applyTheme(theme);
            this._setupPopup();
            this._refreshLayerState();
        },

        deactivate() {
            activeTex = null;
            document.getElementById('zom-empty')?.style.setProperty('display', '');
            document.getElementById('zom-editor')?.style.setProperty('display', 'none');
        },

        _setupPopup() {
            if (this._popupBound) return;
            const toggle = document.getElementById('zom-settings-toggle');
            const popup = document.getElementById('zom-settings-popup');
            if (toggle && popup) {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isOpen = popup.style.display === 'block';
                    popup.style.display = isOpen ? 'none' : 'block';
                });
                document.addEventListener('click', (e) => {
                    if (popup.style.display === 'block' && !popup.contains(e.target) && e.target !== toggle) {
                        popup.style.display = 'none';
                    }
                });
                popup.addEventListener('click', (e) => e.stopPropagation());
                this._popupBound = true;
            }
        },

        _refreshLayerState(layer) {
            if (!activeTex) return;
            const tex = Texture.all.find(t => t.uuid === activeTex);
            if (!tex) return;

            if (layer === undefined) layer = getActiveLayer(tex);
            const layerName = layer ? layer.name : null;
            const isBase = !tex.layers_enabled || !layerName || layerName === '__base__';

            if (!isBase) {
                this._selectionMode = 'layer';
                this._updateLayerUI(tex, layerName);
            } else {
                this._selectionMode = 'texture';
                this._activeChannel = null;
                this._updateLayerUI(tex);
            }
            this.updateUI(activeTex);
        },

        _updateLayerUI(tex, layerName) {
            if (!tex) return;
            let activeChannel = null;
            if (this._selectionMode === 'layer' && layerName && layerName !== '__base__') {
                activeChannel = getChannelFromLayerName(layerName);
            }
            this._activeChannel = activeChannel;

            const channels = ['m', 'e', 'r', 's'];
            const meta = getTexMeta(tex.uuid);
            for (const ch of channels) {
                const el = document.getElementById(`zom-channel-${ch}`);
                if (!el) continue;
                if (ch === 's' && meta.mode !== 'mers') {
                    el.style.display = 'none';
                    el.querySelectorAll('input, select').forEach(inp => inp.disabled = true);
                    continue;
                }
                const show = activeChannel ? (ch === activeChannel) : true;
                el.style.display = show ? 'block' : 'none';
                el.querySelectorAll('input, select').forEach(inp => inp.disabled = !show);
            }
        },

        _loadState(uuid) {
            const tex = Texture.all.find(t => t.uuid === uuid);
            if (!tex) return;
            const lSt = getActiveLayerState(uuid);
            const meta = getTexMeta(uuid);

            const layer = getActiveLayer(tex);
            if (layer && layer.canvas) {
                captureOriginal(tex, layer, lSt);
            }

            const stored = loadStateFromTexture(tex);
            if (stored) {
                ['m', 'e', 'r', 's'].forEach(ch => {
                    lSt[ch + '_offset'] = stored[ch + '_offset'] ?? 128;
                    lSt[ch + '_level'] = stored[ch + '_level'] ?? 100;
                    lSt[ch + '_src'] = stored[ch + '_src'] || (ch === 'm' ? 'red' : ch === 'e' ? 'green' : ch === 'r' ? 'blue' : 'value');
                });
                lSt._adjust = stored._adjust || defaultAdjustState();
                if (stored._bakedSliders) {
                    lSt._bakedSliders = stored._bakedSliders;
                } else {
                    delete lSt._bakedSliders;
                }
                if (stored._mode) {
                    meta.mode = stored._mode;
                }
            } else {
                const def = defaultLayerState();
                ['m', 'e', 'r', 's'].forEach(ch => {
                    lSt[ch + '_offset'] = def[ch + '_offset'];
                    lSt[ch + '_level'] = def[ch + '_level'];
                    lSt[ch + '_src'] = def[ch + '_src'];
                });
                lSt._adjust = defaultAdjustState();
                delete lSt._bakedSliders;
            }

            // Update sliders
            ['m', 'e', 'r', 's'].forEach(ch => {
                const off = document.getElementById(`zom-offset-${ch}`);
                if (off) off.value = lSt[ch + '_offset'] ?? 128;
                const offVal = document.getElementById(`zom-offset-val-${ch}`);
                if (offVal) offVal.textContent = lSt[ch + '_offset'] ?? 128;
                const lev = document.getElementById(`zom-level-${ch}`);
                if (lev) lev.value = lSt[ch + '_level'] ?? 100;
                const levVal = document.getElementById(`zom-level-val-${ch}`);
                if (levVal) levVal.textContent = lSt[ch + '_level'] ?? 100;
                const src = document.getElementById(`zom-src-${ch}`);
                if (src) src.value = lSt[ch + '_src'] || 'red';
            });

            const adj = lSt._adjust || defaultAdjustState();
            ['hue', 'sat', 'bri', 'con'].forEach(id => {
                const key = { hue: 'hue', sat: 'saturation', bri: 'brightness', con: 'contrast' }[id];
                const sl = document.getElementById(`zom-adj-${id}`);
                if (sl) sl.value = adj[key] ?? 0;
                const val = document.getElementById(`zom-adj-${id}-val`);
                if (val) val.textContent = adj[key] ?? 0;
            });

            const merBtn = document.getElementById('zom-mode-mer');
            const mersBtn = document.getElementById('zom-mode-mers');
            if (merBtn) merBtn.classList.toggle('zom-on', meta.mode === 'mer');
            if (mersBtn) mersBtn.classList.toggle('zom-on', meta.mode === 'mers');
            const sBtn = document.getElementById('zom-chbtn-s');
            if (sBtn) sBtn.style.display = meta.mode === 'mers' ? '' : 'none';

            // Refresh layer-aware channel UI now that state is loaded
            this._refreshLayerState();
            this.updateUI(uuid);

            if (lSt._origData && !stored) {
                saveStateToTexture(uuid);
            }
        },

        // ─── Existing methods ─────────────────────────────────────────────────

        setMode(mode) {
            if (!activeTex) return;
            const meta = getTexMeta(activeTex);
            meta.mode = mode;
            const merBtn = document.getElementById('zom-mode-mer');
            const mersBtn = document.getElementById('zom-mode-mers');
            if (merBtn) merBtn.classList.toggle('zom-on', mode === 'mer');
            if (mersBtn) mersBtn.classList.toggle('zom-on', mode === 'mers');
            const sBtn = document.getElementById('zom-chbtn-s');
            if (sBtn) sBtn.style.display = mode === 'mers' ? '' : 'none';
            const tex = Texture.all.find(t => t.uuid === activeTex);
            if (tex) this._refreshLayerState();
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        render() {
            if (!activeTex) { this.deactivate(); return; }
            const on = document.getElementById('zom-pbr-enabled');
            on?.style.setProperty('display', '');
            this.renderPresets();
        },

        setPreviewChannel(ch) {
            this._previewChannel = ch;
            document.querySelectorAll('#zom-chan-select .zom-chbtn').forEach(btn => {
                btn.classList.toggle('zom-on', btn.dataset.ch === ch);
            });
            if (activeTex) this.updateUI(activeTex);
        },

        updateOffset(ch) {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const sl = document.getElementById(`zom-offset-${ch}`);
            const val = +sl.value;
            lSt[ch + '_offset'] = val;
            document.getElementById(`zom-offset-val-${ch}`).textContent = val;
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        updateLevel(ch) {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const sl = document.getElementById(`zom-level-${ch}`);
            const val = +sl.value;
            lSt[ch + '_level'] = val;
            document.getElementById(`zom-level-val-${ch}`).textContent = val;
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        updateSource(ch) {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const src = document.getElementById(`zom-src-${ch}`).value;
            lSt[ch + '_src'] = src;
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        updateAdjust(id) {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const sl = document.getElementById(`zom-adj-${id}`);
            const val = +sl.value;
            const key = { hue: 'hue', sat: 'saturation', bri: 'brightness', con: 'contrast' }[id];
            lSt._adjust[key] = val;
            document.getElementById(`zom-adj-${id}-val`).textContent = val;
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        resetAdjust() {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const adj = defaultAdjustState();
            lSt._adjust = adj;
            ['hue', 'sat', 'bri', 'con'].forEach(id => {
                const key = { hue: 'hue', sat: 'saturation', bri: 'brightness', con: 'contrast' }[id];
                const sl = document.getElementById(`zom-adj-${id}`);
                if (sl) sl.value = adj[key];
                const val = document.getElementById(`zom-adj-${id}-val`);
                if (val) val.textContent = adj[key];
            });
            applyLiveToTexture(activeTex);
            this.updateUI(activeTex);
        },

        revertTexture() { if (activeTex) revertTexture(activeTex); },
        duplicateAsMer() { if (activeTex) duplicateAsMer(activeTex); },
        duplicateAsMers() { if (activeTex) duplicateAsMers(activeTex); },
        extractColors() { if (activeTex) extractUniqueColors(activeTex); },
        extractChannels() { if (activeTex) extractChannels(activeTex); },

        saveTheme() {
            const input = document.getElementById('zom-save-theme-name');
            if (!input) return;
            saveThemeToLibrary(input.value);
            input.value = '';
        },

        loadTheme(name) {
            if (!name) return;
            loadThemeFromLibrary(name);
            const select = document.getElementById('zom-saved-themes-select');
            if (select) select.value = '';
        },

        deleteTheme() {
            const select = document.getElementById('zom-saved-themes-select');
            if (!select || !select.value) return Blockbench.showQuickMessage('Select a theme to delete.');
            deleteThemeFromLibrary(select.value);
            select.value = '';
        },

        setFontSize(size) { applyFontSize(size); },
        setTheme(theme) { applyTheme(theme); },
        toggleGradientOptions(show) { toggleGradientOptions(show); },
        updateCustomTheme() { updateCustomTheme(); },

        updateUI(uuid) {
            if (!uuid) return;
            const lSt = getActiveLayerState(uuid);
            const meta = getTexMeta(uuid);

            ['m', 'e', 'r', 's'].forEach(ch => {
                const v = document.getElementById(`zom-offset-val-${ch}`);
                if (v) v.textContent = lSt[ch + '_offset'] ?? 128;
                const lv = document.getElementById(`zom-level-val-${ch}`);
                if (lv) lv.textContent = lSt[ch + '_level'] ?? 100;
            });

            const tex = Texture.all.find(t => t.uuid === uuid);
            if (!tex) return;

            const sw = document.getElementById('zom-swatch');
            if (!sw) return;
            const ctx2 = sw.getContext('2d');
            ctx2.imageSmoothingEnabled = false;
            ctx2.clearRect(0, 0, sw.width, sw.height);

            const chSel = this._previewChannel || 'composite';

            if (chSel === 'composite') {
                if (tex.canvas) {
                    ctx2.drawImage(tex.canvas, 0, 0, sw.width, sw.height);
                    const debugEl = document.getElementById('zom-debug');
                    if (debugEl) debugEl.textContent = 'Composite view (texture canvas)';
                }
            } else {
                const matchedLayer = findLayerForChannel(tex, chSel);
                if (matchedLayer && matchedLayer.canvas) {
                    ctx2.drawImage(matchedLayer.canvas, 0, 0, sw.width, sw.height);
                    const debugEl = document.getElementById('zom-debug');
                    if (debugEl) debugEl.textContent = `Layer: ${matchedLayer.name}`;
                } else {
                    const imgData = computeFinalImageData(uuid);
                    if (imgData) {
                        const idx = CH_INDEX[chSel];
                        const out = new Uint8ClampedArray(imgData.data);
                        for (let i = 0; i < out.length; i += 4) {
                            const val = out[i + idx];
                            if (chSel === 'm') {
                                out[i] = val;
                                out[i + 1] = 0;
                                out[i + 2] = 0;
                                out[i + 3] = 255;
                            } else if (chSel === 'e') {
                                out[i] = 0;
                                out[i + 1] = val;
                                out[i + 2] = 0;
                                out[i + 3] = 255;
                            } else if (chSel === 'r') {
                                out[i] = 0;
                                out[i + 1] = 0;
                                out[i + 2] = val;
                                out[i + 3] = 255;
                            } else if (chSel === 's') {
                                out[i] = val;
                                out[i + 1] = val;
                                out[i + 2] = val;
                                out[i + 3] = 255;
                            }
                        }
                        const tmp = document.createElement('canvas');
                        tmp.width = imgData.width; tmp.height = imgData.height;
                        tmp.getContext('2d').putImageData(new ImageData(out, imgData.width, imgData.height), 0, 0);
                        ctx2.drawImage(tmp, 0, 0, sw.width, sw.height);
                        const debugEl = document.getElementById('zom-debug');
                        if (debugEl) debugEl.textContent = `Extracted ${chSel.toUpperCase()} from composite`;
                    }
                }
            }

            try {
                const ctx = tex.canvas ? tex.canvas.getContext('2d') : null;
                if (ctx) {
                    const cx = Math.floor(tex.canvas.width / 2);
                    const cy = Math.floor(tex.canvas.height / 2);
                    const d = ctx.getImageData(cx, cy, 1, 1).data;
                    const m = d[0], e = d[1], r = d[2], s = d[3];
                    const [ml, md] = metalInfo(m);
                    const [el2, ed] = emitInfo(e);
                    const [rl, rd] = roughInfo(r);
                    const [sl2, sd] = sssInfo(s);
                    this._setPill('zom-pill-m', ml, ml === 'Non-metal' ? 'off' : 'warn');
                    this._setPill('zom-pill-e', el2, el2 === 'Off' ? 'off' : 'green');
                    this._setPill('zom-pill-r', rl, 'blue');
                    this._setPill('zom-pill-s', sl2, sl2 === 'None' ? 'off' : 'blue');
                    document.getElementById('zom-desc-m').textContent = md;
                    document.getElementById('zom-desc-e').textContent = ed;
                    document.getElementById('zom-desc-r').textContent = rd;
                    document.getElementById('zom-desc-s').textContent = sd;

                    const hex = meta.mode === 'mers'
                        ? '#' + toHex2(m) + toHex2(e) + toHex2(r) + toHex2(s)
                        : '#' + toHex2(m) + toHex2(e) + toHex2(r);
                    document.getElementById('zom-finish').textContent = rl;
                    document.getElementById('zom-finish-sub').textContent = rd;
                    document.getElementById('zom-hex').textContent = hex;
                }
            } catch (e) { /* ignore */ }
        },

        _setPill(id, label, cls) {
            const el = document.getElementById(id); if (!el) return;
            el.textContent = label; el.className = 'zom-pill zom-pill-' + cls;
        },

        renderPresets() {
            const bar = document.getElementById('zom-presets'); if (!bar) return;
            bar.innerHTML = '';
            const user = loadUserPresets();
            [...BUILTIN_PRESETS.map((p, i) => ({ ...p, key: 'b' + i, builtin: true })),
            ...user.map((p, i) => ({ ...p, key: 'u' + i, builtin: false }))
            ].forEach(p => {
                const btn = document.createElement('button');
                btn.className = 'zom-pbtn' + (p.builtin ? '' : ' zom-user');
                btn.textContent = p.name;
                btn.onclick = () => this._applyPreset(p);
                if (!p.builtin) {
                    btn.title = 'Right-click to delete';
                    btn.oncontextmenu = e => {
                        e.preventDefault();
                        const u = loadUserPresets();
                        u.splice(parseInt(p.key.slice(1)), 1);
                        saveUserPresets(u); this.renderPresets();
                    };
                }
                bar.appendChild(btn);
            });
        },

        _applyPreset(p) {
            if (!activeTex) return;
            const lSt = getActiveLayerState(activeTex);
            const presetValues = {
                m: p.m ?? 128,
                e: p.e ?? 128,
                r: p.r ?? 128,
                s: p.s ?? 128
            };

            ['m', 'e', 'r', 's'].forEach(ch => {
                const val = presetValues[ch];
                lSt[ch + '_offset'] = val;
                lSt[ch + '_level'] = 100;
                const defaultSrc = { m: 'red', e: 'green', r: 'blue', s: 'value' };
                lSt[ch + '_src'] = defaultSrc[ch];
                const off = document.getElementById(`zom-offset-${ch}`);
                if (off) off.value = val;
                const offVal = document.getElementById(`zom-offset-val-${ch}`);
                if (offVal) offVal.textContent = val;
                const lev = document.getElementById(`zom-level-${ch}`);
                if (lev) lev.value = 100;
                const levVal = document.getElementById(`zom-level-val-${ch}`);
                if (levVal) levVal.textContent = 100;
                const src = document.getElementById(`zom-src-${ch}`);
                if (src) src.value = defaultSrc[ch];
            });
            const savedChannel = this._activeChannel;
            this._activeChannel = null;
            applyLiveToTexture(activeTex);
            this._activeChannel = savedChannel;

            this.updateUI(activeTex);
            Blockbench.showQuickMessage(`Applied preset "${p.name}" to current texture`);
        },

        savePreset() {
            const nameEl = document.getElementById('zom-preset-name');
            const name = nameEl ? nameEl.value.trim() : '';
            if (!name) { Blockbench.showQuickMessage('Enter a preset name'); return; }
            if (!activeTex) return;
            const u = loadUserPresets();

            const entry = {
                m: +document.getElementById('zom-offset-m')?.value ?? 128,
                e: +document.getElementById('zom-offset-e')?.value ?? 128,
                r: +document.getElementById('zom-offset-r')?.value ?? 128,
                s: +document.getElementById('zom-offset-s')?.value ?? 128,
                name
            };
            const i = u.findIndex(p => p.name === name);
            if (i >= 0) u[i] = entry; else u.push(entry);
            saveUserPresets(u);
            if (nameEl) nameEl.value = '';
            this.renderPresets();
            Blockbench.showQuickMessage('Preset saved');
        },

        openForTexture(tex) {
            activeTex = tex.uuid;
            openPanel();
        }
    };

    // ─── Panel ──────────────────────────────────────────────────────────────────

    let panel;
    function openPanel() {
        if (panel) {
            panel.update();
            if (activeTex) Zomb1esPBR.activate(activeTex);
        }
    }

    function initPanel() {
        panel = new Panel('zom_pbr_panel', {
            id: 'zom_pbr_panel', name: 'Zomb1es PBR Editor',
            fill_height: true, icon: 'layers',
            condition: { modes: ['edit', 'paint'] },
            default_position: {
                slot: 'left_bar', float_position: [0, 0],
                float_size: [310, 880], height: 880
            },
            component: {
                template: `<div id="zom-panel-mount"></div>`,
                mounted() {
                    this.$el.innerHTML = buildPanelHTML();
                    injectStyles();
                    ['m', 'e', 'r', 's'].forEach(ch => {
                        const src = document.getElementById(`zom-src-${ch}`);
                        if (src) src.onchange = () => Zomb1esPBR.updateSource(ch);
                    });
                    const sel = Texture.all.find(t => t.selected);
                    if (sel) Zomb1esPBR.activate(sel.uuid);
                    else Zomb1esPBR.deactivate();
                    Zomb1esPBR.renderPresets();
                }
            }
        });
        _panels.push(panel);
    }

    // ─── Events ─────────────────────────────────────────────────────────────────

    function initEvents() {
        // Texture selection – switch to texture mode
        Blockbench.on('select_texture', ({ texture }) => {
            if (!texture) {
                Zomb1esPBR.deactivate();
                return;
            }
            Zomb1esPBR.activate(texture.uuid);
        });

        Blockbench.on('update_selection', () => {
            if (!activeTex) return;
            const tex = Texture.all.find(t => t.uuid === activeTex);
            if (!tex) return;
            const layer = getActiveLayer(tex);
            if (layer && layer.canvas) {
                const lSt = getActiveLayerState(activeTex);
                captureOriginal(tex, layer, lSt);
            }
            Zomb1esPBR._refreshLayerState(layer);
        });

        Blockbench.on('load_project', () => {
            texState = {};
            const sel = Texture.all.find(t => t.selected);
            if (sel) {
                Zomb1esPBR.activate(sel.uuid);
            } else {
                Zomb1esPBR.deactivate();
            }
        });
    }

    // ─── Layer selection hook ──────────────────────────────────────────────────

    let _origLayerSelect = null;

    function hookLayerSelect() {
        if (typeof TextureLayer === 'undefined' || !TextureLayer.prototype.select) return;
        if (_origLayerSelect) return; // already hooked
        _origLayerSelect = TextureLayer.prototype.select;
        TextureLayer.prototype.select = function (...args) {
            const result = _origLayerSelect.apply(this, args);
            try {
                if (activeTex && this.texture && this.texture.uuid === activeTex) {
                    Zomb1esPBR._refreshLayerState(this);
                }
            } catch (e) { }
            return result;
        };
    }

    function unhookLayerSelect() {
        if (_origLayerSelect && typeof TextureLayer !== 'undefined') {
            TextureLayer.prototype.select = _origLayerSelect;
        }
        _origLayerSelect = null;
    }

    // ─── State persistence property ────────────────────────────────────────────
    let _stateProperty = null;

    function registerStateProperty() {
        if (_stateProperty) return; // already registered
        _stateProperty = new Property(Texture, 'string', 'zomb1es_pbr_state', { default: '' });
    }

    function unregisterStateProperty() {
        if (_stateProperty) {
            try { _stateProperty.delete(); } catch (e) { }
        }
        _stateProperty = null;
    }

    // ─── Context menus ─────────────────────────────────────────────────────────

    function initContextMenus() {
        const open = new Action('zom_open_pbr', {
            id: 'zom_open_pbr', name: 'Open in Zomb1es PBR Editor', icon: 'layers',
            condition: () => !!Texture.all.find(t => t.selected),
            click() { const t = Texture.all.find(t => t.selected); if (t) Zomb1esPBR.openForTexture(t); }
        });
        Texture.prototype.menu.addAction(open, '#generate_pbr_map');
        MenuBar.addAction(open, 'tools');
        _actions.push(open);
    }

    // ─── Plugin ──────────────────────────────────────────────────────────────────

    Plugin.register(PLUGIN_ID, {
        title: 'Zomb1es PBR Editor', author: 'Zomb1es', icon: 'layers',
        description: 'Live PBR editing with stable state persistence and layer‑aware channel controls.',
        version: VERSION, variant: 'desktop', min_version: '4.8.0',
        tags: ['Minecraft: Bedrock Edition', 'Textures'],
        onload() { registerStateProperty(); initPanel(); initEvents(); initContextMenus(); hookLayerSelect(); },
        onunload() {
            unhookLayerSelect();
            unregisterStateProperty();
            _actions.forEach(a => { try { a.delete(); } catch { } });
            _panels.forEach(p => { try { p.delete(); } catch { } });
            _styles.forEach(s => { try { s.remove(); } catch { } });
            delete window.Zomb1esPBR;
        }
    });

})();

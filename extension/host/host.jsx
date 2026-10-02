/*
 * AutoCaption AE - After Effects host script (ExtendScript, ES3).
 *
 * The panel decides everything (timing, frames, text, keyframes, expressions)
 * and sends a plan; this file only reads project state and applies plans.
 * It never deletes or edits user layers: it works on a temporary duplicate
 * composition for audio rendering and only removes layers it created itself
 * (tagged with the comment prefix below).
 */

var AutoCaption = (function () {
    var TAG = "AutoCaptionAE";
    var TEMP_COMP = "__AutoCaption temp__";

    // ------------------------------------------------------------- JSON out
    function q(s) {
        return '"' + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (c) {
            var m = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
            if (m[c]) { return m[c]; }
            var h = c.charCodeAt(0).toString(16);
            return "\\u" + ("0000" + h).slice(-4);
        }) + '"';
    }
    function stringify(v) {
        var i, out, k;
        if (v === null || v === undefined) { return "null"; }
        if (typeof v === "number") { return isFinite(v) ? String(v) : "null"; }
        if (typeof v === "boolean") { return v ? "true" : "false"; }
        if (typeof v === "string") { return q(v); }
        if (v instanceof Array) {
            out = [];
            for (i = 0; i < v.length; i++) { out.push(stringify(v[i])); }
            return "[" + out.join(",") + "]";
        }
        out = [];
        for (k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== "function") { out.push(q(k) + ":" + stringify(v[k])); }
        }
        return "{" + out.join(",") + "}";
    }
    function ok(data) { data = data || {}; data.ok = true; return stringify(data); }
    function fail(code, message, extra) {
        var o = extra || {};
        o.ok = false; o.code = code; o.message = message;
        return stringify(o);
    }
    function guard(fn) {
        return function () {
            try {
                return fn.apply(null, arguments);
            } catch (e) {
                return fail("HOST_ERROR", "After Effects reported an error: " + e.toString(), { line: e.line || null });
            }
        };
    }

    // -------------------------------------------------------------- helpers
    function compById(id) {
        var i, it;
        if (!app.project) { return null; }
        if (id) {
            try {
                it = app.project.itemByID(id);
                if (it && it instanceof CompItem) { return it; }
            } catch (e1) { /* fall through */ }
            for (i = 1; i <= app.project.numItems; i++) {
                it = app.project.item(i);
                if (it instanceof CompItem && it.id === id) { return it; }
            }
            return null;
        }
        it = app.project.activeItem;
        return (it && it instanceof CompItem) ? it : null;
    }

    function layerType(layer) {
        if (!(layer instanceof AVLayer)) { return "unknown"; }
        var src = layer.source;
        if (src instanceof CompItem) { return "precomp"; }
        if (src instanceof FootageItem) {
            if (src.hasVideo && !src.footageMissing && src.mainSource && !src.mainSource.isStill) { return "video"; }
            if (src.hasAudio) { return "audio"; }
        }
        return "unknown";
    }

    function describeLayer(layer) {
        var d = {
            name: layer.name, index: layer.index, type: layerType(layer), hasAudio: false, audioEnabled: false,
            enabled: layer.enabled, inPoint: layer.inPoint, outPoint: layer.outPoint, startTime: layer.startTime,
            stretch: layer.stretch, timeRemap: false, sourcePath: null, sourceDuration: null, id: null
        };
        try { d.id = layer.id; } catch (e0) { d.id = null; }
        if (layer instanceof AVLayer) {
            d.hasAudio = layer.hasAudio;
            try { d.audioEnabled = layer.audioEnabled; } catch (e1) { d.audioEnabled = false; }
            try { d.timeRemap = layer.timeRemapEnabled; } catch (e2) { d.timeRemap = false; }
            var src = layer.source;
            if (src instanceof FootageItem && src.file) {
                d.sourcePath = src.file.fsName;
                d.sourceDuration = src.duration;
                d.footageMissing = src.footageMissing;
            }
        }
        return d;
    }

    function describeComp(comp) {
        return {
            name: comp.name, id: comp.id, fps: comp.frameRate, frameDuration: comp.frameDuration,
            duration: comp.duration, displayStartTime: comp.displayStartTime, width: comp.width,
            height: comp.height, time: comp.time
        };
    }

    // ------------------------------------------------------------ selection
    function getSelection() {
        if (!app.project) { return fail("NO_PROJECT", "Open a project in After Effects."); }
        var comp = compById(null);
        if (!comp) { return fail("NO_COMP", "Open a composition and select an audio, video, or precomp layer."); }
        var sel = comp.selectedLayers, layers = [], i;
        for (i = 0; i < sel.length; i++) { layers.push(describeLayer(sel[i])); }
        return ok({ comp: describeComp(comp), layers: layers, aeVersion: app.version });
    }

    function layerState(compId, indices) {
        var comp = compById(compId), out = [], i, L;
        if (!comp) { return fail("COMP_GONE", "The composition used for transcription no longer exists."); }
        for (i = 0; i < indices.length; i++) {
            if (indices[i] < 1 || indices[i] > comp.numLayers) { out.push(null); continue; }
            L = comp.layer(indices[i]);
            out.push(describeLayer(L));
        }
        return ok({ comp: describeComp(comp), layers: out });
    }

    // --------------------------------------------------------- audio render
    function pickTemplate(om) {
        var t = om.templates, i, prefer = [/^WAV/i, /WAV/i, /AIFF/i, /audio only/i];
        var p;
        for (p = 0; p < prefer.length; p++) {
            for (i = 0; i < t.length; i++) {
                if (prefer[p].test(t[i]) && !/HIDDEN/i.test(t[i])) { return t[i]; }
            }
        }
        return null;
    }

    /*
     * Renders the audio of the selected layers exactly as the composition
     * plays it (start time, trims, stretch, remap, nested precomps) from a
     * temporary duplicate composition. Returns the comp time that matches
     * t=0 of the rendered file.
     */
    function renderAudio(args) {
        var comp = compById(args.compId), rq = app.project.renderQueue, i, L, dup = null, item = null;
        var paused = [], outFolder = new Folder(args.outDir), start, end, sel = {}, found = null;
        if (!comp) { return fail("COMP_GONE", "The composition no longer exists."); }
        if (rq.rendering) { return fail("RENDER_BUSY", "After Effects is rendering. Wait for the render to finish, then try again."); }
        if (!outFolder.exists && !outFolder.create()) { return fail("TEMP_UNWRITABLE", "Could not create a temporary folder."); }

        start = comp.duration; end = 0;
        for (i = 0; i < args.layerIndices.length; i++) {
            if (args.layerIndices[i] < 1 || args.layerIndices[i] > comp.numLayers) {
                return fail("LAYER_GONE", "The selected layer no longer exists.");
            }
            L = comp.layer(args.layerIndices[i]);
            sel[L.index] = true;
            start = Math.min(start, Math.max(0, Math.min(L.inPoint, L.outPoint)));
            end = Math.max(end, Math.min(comp.duration, Math.max(L.inPoint, L.outPoint)));
        }
        if (end - start < 0.1) { return fail("RANGE_EMPTY", "The selected layer is not inside the composition's time range."); }

        app.beginSuppressDialogs();
        try {
            dup = comp.duplicate();
            dup.name = TEMP_COMP;
            dup.comment = TAG + ":temp";
            for (i = 1; i <= dup.numLayers; i++) {
                L = dup.layer(i);
                try { L.solo = false; } catch (e1) { /* not soloable */ }
                if (L instanceof AVLayer && L.hasAudio) {
                    L.audioEnabled = sel[i] === true;
                }
            }
            dup.workAreaStart = start;
            dup.workAreaDuration = end - start;
            for (i = 1; i <= rq.numItems; i++) {
                if (rq.item(i).status === RQItemStatus.QUEUED) { rq.item(i).render = false; paused.push(rq.item(i)); }
            }
            item = rq.items.add(dup);
            item.timeSpanStart = start;
            item.timeSpanDuration = end - start;
            var om = item.outputModule(1), tpl = pickTemplate(om);
            if (tpl) { om.applyTemplate(tpl); }
            try { om.setSettings({ "Output Audio": "On" }); } catch (e2) { /* older AE */ }
            if (!tpl) {
                try { om.setSettings({ "Format": "WAV" }); } catch (e3) { /* keep default format */ }
            }
            om.file = new File(outFolder.fsName + "/input.wav");
            rq.render();
        } catch (e) {
            cleanupRender(item, dup, paused);
            app.endSuppressDialogs(false);
            return fail("RENDER_FAILED", "After Effects could not render the layer's audio.", { detail: e.toString() });
        }
        cleanupRender(item, dup, paused);
        app.endSuppressDialogs(false);

        var files = outFolder.getFiles("input*");
        for (i = 0; i < files.length; i++) {
            if (files[i] instanceof File && files[i].length > 0) { found = files[i]; break; }
        }
        if (!found) { return fail("RENDER_EMPTY", "After Effects did not produce an audio file."); }
        return ok({ path: found.fsName, audioOffset: start, duration: end - start });
    }

    function cleanupRender(item, dup, paused) {
        var i;
        try { if (item) { item.remove(); } } catch (e1) { /* already gone */ }
        for (i = 0; i < paused.length; i++) {
            try { paused[i].render = true; } catch (e2) { /* item removed by user */ }
        }
        try { if (dup) { dup.remove(); } } catch (e3) { /* already gone */ }
    }

    /** Remove temporary comps left by a crash (only ones we tagged). */
    function cleanupTemp() {
        var i, it, n = 0;
        if (!app.project) { return ok({ removed: 0 }); }
        for (i = app.project.numItems; i >= 1; i--) {
            it = app.project.item(i);
            if (it instanceof CompItem && it.name === TEMP_COMP && it.comment === TAG + ":temp") { it.remove(); n++; }
        }
        return ok({ removed: n });
    }

    // ------------------------------------------------------------- captions
    function existingCaptions(compId) {
        var comp = compById(compId), i, n = 0, sets = {}, names = [];
        if (!comp) { return fail("COMP_GONE", "The composition no longer exists."); }
        for (i = 1; i <= comp.numLayers; i++) {
            var c = comp.layer(i).comment;
            if (c && c.indexOf(TAG + ":") === 0) {
                n++;
                var id = c.split(":")[1];
                if (!sets[id]) { sets[id] = true; names.push(id); }
            }
        }
        return ok({ count: n, sets: names.length });
    }

    function setEase(prop) {
        var k, d, ease = [], dims = 1;
        if (prop.numKeys < 2) { return; }
        if (prop.propertyValueType === PropertyValueType.TwoD) { dims = 2; }
        if (prop.propertyValueType === PropertyValueType.ThreeD) { dims = 3; }
        for (d = 0; d < dims; d++) { ease.push(new KeyframeEase(0, 33.33)); }
        for (k = 1; k <= prop.numKeys; k++) {
            try { prop.setTemporalEaseAtKey(k, ease, ease); } catch (e) { /* hold keys etc. */ }
        }
    }

    function applyKeys(prop, keys, map) {
        var i;
        if (!keys || !keys.length) { return; }
        for (i = 0; i < keys.length; i++) { prop.setValueAtTime(keys[i][0], map(keys[i][1])); }
        setEase(prop);
    }

    function styleText(layer, text, st) {
        var tp = layer.property("ADBE Text Properties").property("ADBE Text Document");
        var td = tp.value;
        try { td.resetCharStyle(); td.resetParagraphStyle(); } catch (e0) { /* AE < 13.6 */ }
        td.text = text;
        try { td.font = st.font; } catch (e1) { /* missing font: AE substitutes */ }
        td.fontSize = st.fontSize;
        td.applyFill = true;
        td.fillColor = st.fillRGB;
        td.applyStroke = st.strokeEnabled && st.strokeWidth > 0;
        if (td.applyStroke) {
            td.strokeColor = st.strokeRGB;
            td.strokeWidth = st.strokeWidth;
            td.strokeOverFill = false;
        }
        td.tracking = st.tracking;
        if (st.leading > 0) { td.autoLeading = false; td.leading = st.leading; }
        td.justification = st.align === "left" ? ParagraphJustification.LEFT_JUSTIFY :
            (st.align === "right" ? ParagraphJustification.RIGHT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY);
        tp.setValue(td);
    }

    function addWordAnimator(layer, wa, expr) {
        var textProps = layer.property("ADBE Text Properties");
        var an = textProps.property("ADBE Text Animators").addProperty("ADBE Text Animator");
        an.name = "AutoCaption Words";
        var sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
        sel.property("ADBE Text Range Type2").setValue(1); // Based On: Characters
        sel.property("ADBE Text Expressible Amount").expression = expr;
        var props = an.property("ADBE Text Animator Properties");
        if (wa.opacity !== undefined && wa.opacity !== null) { props.addProperty("ADBE Text Opacity").setValue(wa.opacity); }
        if (wa.scale !== undefined && wa.scale !== null) {
            var sc = props.addProperty("ADBE Text Scale 3D");
            try { sc.setValue([wa.scale, wa.scale, 100]); } catch (e1) { sc.setValue([wa.scale, wa.scale]); }
        }
        if (wa.fillRGB) {
            var fc = props.addProperty("ADBE Text Fill Color");
            try { fc.setValue(wa.fillRGB); } catch (e2) { fc.setValue([wa.fillRGB[0], wa.fillRGB[1], wa.fillRGB[2], 1]); }
        }
        try {
            var more = textProps.property("ADBE Text More Options");
            more.property("ADBE Text Anchor Point Grouping").setValue(2); // Word: scale each word around itself
            more.property("ADBE Text Group Alignment").setValue([0, -35]);
        } catch (e3) { /* optional */ }
    }

    function addShadow(layer, st) {
        var fx = layer.property("ADBE Effect Parade").addProperty("ADBE Drop Shadow");
        try { fx.property("ADBE Drop Shadow-0001").setValue(st.shadowRGB); } catch (e1) {
            fx.property("ADBE Drop Shadow-0001").setValue([st.shadowRGB[0], st.shadowRGB[1], st.shadowRGB[2], 1]);
        }
        fx.property("ADBE Drop Shadow-0002").setValue(Math.round(st.shadowOpacity * 255));
        fx.property("ADBE Drop Shadow-0003").setValue(135);
        fx.property("ADBE Drop Shadow-0004").setValue(st.shadowDistance);
        fx.property("ADBE Drop Shadow-0005").setValue(st.shadowSoftness);
    }

    function addBackground(comp, textLayer, st, setTag) {
        var bg = comp.layers.addShape();
        bg.name = textLayer.name + " BG";
        bg.comment = setTag;
        var grp = bg.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        var vecs = grp.property("ADBE Vectors Group");
        var rect = vecs.addProperty("ADBE Vector Shape - Rect");
        var nm = textLayer.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        var pad = st.padding;
        rect.property("ADBE Vector Rect Size").expression =
            'var r=thisComp.layer("' + nm + '").sourceRectAtTime(time,false);[r.width+' + (2 * pad) + ',r.height+' + (2 * pad) + '];';
        rect.property("ADBE Vector Rect Position").expression =
            'var r=thisComp.layer("' + nm + '").sourceRectAtTime(time,false);[r.left+r.width/2,r.top+r.height/2];';
        rect.property("ADBE Vector Rect Roundness").setValue(Math.round(pad * 0.6));
        var fill = vecs.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue(st.backgroundRGB);
        fill.property("ADBE Vector Fill Opacity").setValue(Math.round(st.backgroundOpacity * 100));
        bg.parent = textLayer;
        bg.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
        bg.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
        bg.property("ADBE Transform Group").property("ADBE Opacity").expression = "parent.transform.opacity";
        bg.inPoint = textLayer.inPoint;
        bg.outPoint = textLayer.outPoint;
        bg.moveAfter(textLayer);
        return bg;
    }

    function nameTaken(comp, name, except) {
        var i;
        for (i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i) !== except && comp.layer(i).name === name) { return true; }
        }
        return false;
    }

    function createLayers(plan, opts) {
        var comp = compById(opts.compId), i, created = [], L;
        if (!comp) { return fail("COMP_GONE", "The composition used for transcription no longer exists."); }
        if (!plan.layers || !plan.layers.length) { return fail("NO_CAPTIONS", "There are no captions to create."); }
        var fd = comp.frameDuration;
        app.beginUndoGroup("AutoCaption: Create Text Layers");
        try {
            if (opts.mode === "replace") {
                for (i = comp.numLayers; i >= 1; i--) {
                    L = comp.layer(i);
                    if (L.comment && L.comment.indexOf(TAG + ":") === 0) {
                        L.locked = false;
                        L.remove();
                    }
                }
            }
            var setId = String(new Date().getTime());
            var setTag = TAG + ":" + setId;
            var st = plan.style, W = comp.width, H = comp.height;
            var root = comp.layers.addNull(comp.duration);
            var setName = plan.setName, n = 2;
            while (nameTaken(comp, setName, root)) { setName = plan.setName + " " + n; n++; }
            root.name = setName;
            root.comment = setTag + ":root";
            root.label = 9;
            root.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([0, 0]);
            root.property("ADBE Transform Group").property("ADBE Position").setValue([0, 0]);
            root.inPoint = 0;
            root.outPoint = comp.duration;

            for (i = plan.layers.length - 1; i >= 0; i--) {
                var lp = plan.layers[i];
                var inP = Math.max(0, lp.inPoint), outP = Math.min(comp.duration, lp.outPoint);
                if (outP - inP < fd * 0.5) { continue; }
                L = comp.layers.addText(lp.text);
                L.name = lp.name;
                L.comment = setTag;
                L.label = 9;
                styleText(L, lp.text, st);
                L.startTime = 0;
                L.inPoint = inP;
                L.outPoint = outP;
                L.parent = root;
                var tr = L.property("ADBE Transform Group");
                var r = L.sourceRectAtTime(inP, false);
                tr.property("ADBE Anchor Point").setValue([r.left + r.width / 2, r.top + r.height / 2]);
                var base = [W * st.positionX, H * st.positionY];
                tr.property("ADBE Position").setValue(base);
                tr.property("ADBE Scale").setValue([st.scale, st.scale]);
                applyKeys(tr.property("ADBE Opacity"), lp.opacity, function (v) { return v; });
                applyKeys(tr.property("ADBE Scale"), lp.scale, function (v) { return [v * st.scale / 100, v * st.scale / 100]; });
                applyKeys(tr.property("ADBE Position"), lp.offsetY, function (v) { return [base[0], base[1] + v]; });
                if (lp.wordExpression && plan.wordAnimator) { addWordAnimator(L, plan.wordAnimator, lp.wordExpression); }
                if (st.shadowEnabled) { addShadow(L, st); }
                if (st.backgroundEnabled) { addBackground(comp, L, st, setTag); }
                created.push(L);
            }
            root.moveToBeginning();
            for (i = 1; i <= comp.numLayers; i++) { comp.layer(i).selected = false; }
            for (i = 0; i < created.length; i++) { created[i].selected = true; }
        } catch (e) {
            app.endUndoGroup();
            return fail("CREATE_FAILED", "Could not create all caption layers: " + e.toString(), { line: e.line || null, created: created.length });
        }
        app.endUndoGroup();
        try { comp.openInViewer(); } catch (e2) { /* viewer optional */ }
        return ok({ created: created.length, setName: root.name });
    }

    function jumpTo(compId, t) {
        var comp = compById(compId);
        if (!comp) { return fail("COMP_GONE", "The composition no longer exists."); }
        comp.time = Math.max(0, Math.min(comp.duration, t));
        try { comp.openInViewer(); } catch (e) { /* ignore */ }
        return ok({});
    }

    function getFonts() {
        var out = [], i, j, fam;
        try {
            if (app.fonts && app.fonts.allFonts) {
                for (i = 0; i < app.fonts.allFonts.length && out.length < 3000; i++) {
                    fam = app.fonts.allFonts[i];
                    for (j = 0; j < fam.length; j++) {
                        out.push({ ps: fam[j].postScriptName, family: fam[j].familyName, style: fam[j].styleName });
                    }
                }
            }
        } catch (e) { /* AE < 24 has no font API */ }
        return ok({ fonts: out });
    }

    function info() {
        return ok({ aeVersion: app.version, build: app.buildName || "", language: String(app.isoLanguage || ""),
            projectSaved: !!(app.project && app.project.file) });
    }

    function chooseFolder(title) {
        var f = Folder.selectDialog(title || "Choose folder");
        return ok({ path: f ? f.fsName : null });
    }

    return {
        getSelection: guard(getSelection),
        layerState: guard(layerState),
        renderAudio: guard(renderAudio),
        cleanupTemp: guard(cleanupTemp),
        existingCaptions: guard(existingCaptions),
        createLayers: guard(createLayers),
        jumpTo: guard(jumpTo),
        getFonts: guard(getFonts),
        info: guard(info),
        chooseFolder: guard(chooseFolder),
        _stringify: stringify
    };
}());

/*! RippleFade page transitions. https://github.com/jtymanjr/ripple-fade
 *
 * Load this as a classic script in <head> on every page of the site:
 *
 *   <script src="ripple-fade.js"></script>                      every same-origin link ripples
 *   <script src="ripple-fade.js" data-links="flagged"></script> only links inside [data-ripple]
 *
 * How it works: when a link is clicked, the outgoing page photographs its viewport (html2canvas-pro, loaded lazily
 * from jsDelivr while the page is idle) and leaves the picture in sessionStorage. The incoming page puts that picture
 * up as a cover before its first paint, then ripples it away over the live new page with the simulator's shader:
 * the ring train refracts and fades the old page out (A), and the new page (B) shows through behind it.
 *
 * Opt out per link (or for a whole region) with data-ripple="off". Programmatic use:
 *   RippleFade.navigate(url, { x, y })            full page load with the ripple, from (x, y) in CSS px
 *   RippleFade.transition(updateDom, { x, y })    same-document (SPA) swap: snapshot, await updateDom(), ripple
 *   RippleFade.init({ ...options })               only needed with <script data-manual>, or to change options later
 */
(function () {
    'use strict';
    if (window.RippleFade) return;

    var KEY = 'ripple-fade:snapshot';
    var MAX_AGE = 15000; // ms a snapshot stays valid between click and the next page's start
    var Z = 2147483647;

    // the tuned simulator values (2026-10-06): ripples 2, wavelength .245, speed 2, strength .9, refraction .043,
    // sheen .87, edge softness .8
    var defaults = {
        links: 'all', // 'all' same-origin links, 'flagged' only links inside [data-ripple], 'none' programmatic only
        rings: 2,
        wavelength: 0.245,
        speed: 2,
        strength: 0.9,
        refraction: 0.043,
        sheen: 0.87,
        softness: 0.8,
        origin: 'pointer', // 'pointer' ripples from the click, 'center' from the middle of the screen
        scale: 0, // snapshot pixel ratio; 0 means min(devicePixelRatio, 2)
        quality: 0.82, // snapshot JPEG quality
        captureTimeout: 900, // ms to wait for the snapshot before navigating anyway (the ripple then starts from a flat color)
        reducedMotion: 'skip', // 'skip' plain navigations when the user prefers reduced motion, 'ignore' ripple anyway
        html2canvas: 'https://cdn.jsdelivr.net/npm/html2canvas-pro@2.4.5/dist/html2canvas-pro.min.js',
        capture: null, // optional async function (rect) -> canvas, to replace html2canvas
    };
    var opts = assign({}, defaults);
    var NUMERIC = ['rings', 'wavelength', 'speed', 'strength', 'refraction', 'sheen', 'softness', 'scale', 'quality', 'captureTimeout'];

    function assign(o) {
        for (var i = 1; i < arguments.length; i++) {
            var s = arguments[i];
            if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) o[k] = s[k];
        }
        return o;
    }

    // ---------- options from the script tag: data-links, data-speed, data-rings, ... ----------
    var tag = document.currentScript;
    var tagOpts = {};
    if (tag) {
        for (var k in defaults) {
            var attr = 'data-' + k.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
            if (tag.hasAttribute(attr)) {
                var v = tag.getAttribute(attr);
                tagOpts[k] = NUMERIC.indexOf(k) >= 0 ? parseFloat(v) : v;
            }
        }
    }
    assign(opts, tagOpts);

    function reducedMotion() {
        return opts.reducedMotion !== 'ignore' && window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function rippleParams(o) {
        return { rings: o.rings, wavelength: o.wavelength, speed: o.speed, strength: o.strength, refraction: o.refraction, sheen: o.sheen, softness: o.softness };
    }

    // ---------- the shader: the simulator's RippleFade, drawn as an overlay that holds A and lets B show through ----------
    var VS = 'attribute vec2 p; varying vec2 vUv; void main(){ vUv = p * 0.5 + 0.5; vUv.y = 1.0 - vUv.y; gl_Position = vec4(p, 0.0, 1.0); }';
    var FS = [
        'precision highp float;',
        'varying vec2 vUv;',
        'uniform sampler2D texA;',
        'uniform vec2 uRes, uCenter;',
        'uniform float uFront, uRings, uWave, uAmp, uRefr, uSheen, uSoft;',
        'const float PI = 3.14159265;',
        'void main(){',
        '  vec2 asp = vec2(uRes.x / uRes.y, 1.0);',
        '  vec2 dir = (vUv - uCenter) * asp; float d = length(dir); vec2 n = d > 1e-5 ? dir / d : vec2(0.0);',
        // phase: wavelengths behind the wavefront (<0 still A, >= rings fully B); m: monotone progress over the ring train
        '  float phase = (uFront - d) / uWave;',
        '  float m = clamp(phase / uRings, 0.0, 1.0);',
        '  float env = pow(max((1.0 - m) * m * 4.0, 0.0), uSoft);',
        '  float lead = smoothstep(0.0, 0.5, phase);',
        '  float blend = clamp(m + uAmp * 0.5 * env * sin(phase * 2.0 * PI - PI * 0.5), 0.0, 1.0) * lead;',
        '  float slope = cos(phase * 2.0 * PI) * env * lead;',
        '  vec2 off = n * slope * uRefr / asp;',
        '  vec3 a = texture2D(texA, clamp(vUv + off, 0.0, 1.0)).rgb;',
        // premultiplied: A fades by (1 - blend) so the live page B shows through, and the crest sheen is laid over both
        // as white at strength s (kept as a valid premultiplied colour, rgb <= alpha, which every compositor agrees on)
        '  float alpha = 1.0 - blend;',
        '  float s = clamp(uSheen * 0.25 * max(slope, 0.0) * (1.0 - blend * 0.5), 0.0, 1.0);',
        '  gl_FragColor = vec4(a * alpha * (1.0 - s) + s, alpha * (1.0 - s) + s);',
        '}',
    ].join('\n');

    // Draws the ripple from a snapshot image over the page; resolves when the last ring has passed. The first frame
    // shows A whole (onFirstFrame runs right after it); the rings start once `gate` (optional promise) settles.
    function play(img, at, params, onFirstFrame, gate) {
        return new Promise(function (resolve) {
            var canvas = document.createElement('canvas');
            canvas.setAttribute('data-ripple-ignore', '');
            canvas.setAttribute('aria-hidden', 'true');
            canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:' + Z + ';pointer-events:none;display:block;visibility:visible';
            var gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
            if (!gl) return fallback();
            var prog = program(gl);
            if (!prog) return fallback();

            document.documentElement.appendChild(canvas);
            gl.useProgram(prog);
            var buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
            var loc = gl.getAttribLocation(prog, 'p');
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
            var tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            var U = {};
            ['texA', 'uRes', 'uCenter', 'uFront', 'uRings', 'uWave', 'uAmp', 'uRefr', 'uSheen', 'uSoft'].forEach(function (n) {
                U[n] = gl.getUniformLocation(prog, n);
            });
            gl.uniform1i(U.texA, 0);
            gl.uniform1f(U.uRings, params.rings);
            gl.uniform1f(U.uWave, params.wavelength);
            gl.uniform1f(U.uAmp, params.strength);
            gl.uniform1f(U.uRefr, params.refraction);
            gl.uniform1f(U.uSheen, params.sheen);
            gl.uniform1f(U.uSoft, params.softness);

            var t0 = -1, first = true, open = !gate;
            if (gate) gate.then(function () { open = true; }, function () { open = true; });
            function frame(now) {
                var dpr = Math.min(window.devicePixelRatio || 1, 2);
                var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
                if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
                if (t0 < 0 && open && !first) t0 = now;
                var asp = w / h, cx = at.u, cy = at.v;
                var front = t0 < 0 ? 0 : ((now - t0) / 1000) * params.speed;
                var maxD = Math.hypot(Math.max(cx, 1 - cx) * asp, Math.max(cy, 1 - cy));
                gl.uniform2f(U.uRes, w, h);
                gl.uniform2f(U.uCenter, cx, cy);
                gl.uniform1f(U.uFront, front);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                if (first) { first = false; if (onFirstFrame) onFirstFrame(); }
                if (t0 >= 0 && front > maxD + params.rings * params.wavelength) return done();
                requestAnimationFrame(frame);
            }
            function done() {
                canvas.remove();
                var lose = gl.getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
                resolve();
            }
            requestAnimationFrame(frame);

            // no WebGL: fade the snapshot out with CSS instead
            function fallback() {
                var el = document.createElement('div');
                el.setAttribute('data-ripple-ignore', '');
                el.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';pointer-events:none;background:url("' + (img.src || encode(img, 0.9)) + '") 0 0/100% 100% no-repeat;transition:opacity .6s ease;visibility:visible';
                document.documentElement.appendChild(el);
                if (onFirstFrame) onFirstFrame();
                Promise.resolve(gate).then(function () {
                    requestAnimationFrame(function () {
                        requestAnimationFrame(function () { el.style.opacity = '0'; });
                    });
                    setTimeout(function () { el.remove(); resolve(); }, 650);
                });
            }
        });
    }

    function program(gl) {
        function sh(type, src) {
            var s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
        }
        var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
        if (!vs || !fs) return null;
        var p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
    }

    // ---------- snapshot of the current viewport ----------
    var h2cPromise = null;
    function loadHtml2canvas() {
        if (window.html2canvas) return Promise.resolve(window.html2canvas);
        if (!h2cPromise) {
            h2cPromise = new Promise(function (resolve, reject) {
                var s = document.createElement('script');
                s.src = opts.html2canvas;
                s.async = true;
                s.crossOrigin = 'anonymous';
                s.onload = function () { window.html2canvas ? resolve(window.html2canvas) : reject(new Error('html2canvas missing')); };
                s.onerror = function () { h2cPromise = null; reject(new Error('could not load ' + opts.html2canvas)); };
                document.head.appendChild(s);
            });
        }
        return h2cPromise;
    }
    function preload() {
        if (opts.capture) return;
        var idle = window.requestIdleCallback || function (f) { return setTimeout(f, 200); };
        idle(function () { loadHtml2canvas().catch(function () {}); });
    }

    function pageColor() {
        var c = getComputedStyle(document.body || document.documentElement).backgroundColor;
        if (!c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c)) c = getComputedStyle(document.documentElement).backgroundColor;
        if (!c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c)) c = '#ffffff';
        return c;
    }

    function viewportRect() {
        var de = document.documentElement;
        return { x: window.scrollX, y: window.scrollY, width: de.clientWidth, height: de.clientHeight };
    }

    // -> Promise<canvas>
    function capture() {
        var rect = viewportRect();
        if (opts.capture) return Promise.resolve(opts.capture(rect));
        var scale = opts.scale || Math.min(window.devicePixelRatio || 1, 2);
        return loadHtml2canvas().then(function (h2c) {
            return h2c(document.documentElement, {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                windowWidth: rect.width,
                windowHeight: rect.height,
                scale: scale,
                backgroundColor: pageColor(),
                useCORS: true,
                logging: false,
                ignoreElements: function (el) { return el.hasAttribute && el.hasAttribute('data-ripple-ignore'); },
            });
        });
    }

    function withTimeout(p, ms) {
        return new Promise(function (resolve) {
            var t = setTimeout(function () { resolve(null); }, ms);
            p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) {
                clearTimeout(t);
                if (window.console) console.warn('[RippleFade] snapshot failed:', e);
                resolve(null);
            });
        });
    }

    function encode(canvas, q) {
        try {
            return canvas.toDataURL('image/jpeg', q);
        } catch (e) {
            return null; // tainted: a cross-origin image without CORS slipped in
        }
    }
    function flat(color) {
        var c = document.createElement('canvas');
        c.width = c.height = 2;
        var x = c.getContext('2d');
        x.fillStyle = color || '#fff';
        x.fillRect(0, 0, 2, 2);
        return c;
    }

    function store(record) {
        var json;
        for (var tries = 0; tries < 3; tries++) {
            json = JSON.stringify(record);
            try {
                sessionStorage.setItem(KEY, json);
                return true;
            } catch (e) {
                // over the storage quota: drop to a smaller, lower quality picture, and finally to the flat color
                if (!record.img) return false;
                record.img = tries < 1 && record._canvas ? downscale(record._canvas, 0.5) : null;
            }
        }
        return false;
    }
    function downscale(canvas, f) {
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(canvas.width * f));
        c.height = Math.max(1, Math.round(canvas.height * f));
        c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
        return encode(c, 0.7);
    }

    function originOf(x, y) {
        var de = document.documentElement;
        if (opts.origin === 'center' || x == null || y == null) return { u: 0.5, v: 0.5 };
        return { u: Math.min(1, Math.max(0, x / de.clientWidth)), v: Math.min(1, Math.max(0, y / de.clientHeight)) };
    }

    // ---------- outgoing: snapshot, store, navigate ----------
    var pending = null; // { anchor, promise, t } a snapshot started on pointerdown
    var leaving = false;

    function snapshot() {
        return withTimeout(capture(), opts.captureTimeout);
    }

    function navigate(url, at) {
        if (leaving) return Promise.resolve();
        url = new URL(url, location.href).href;
        if (reducedMotion()) { location.assign(url); return Promise.resolve(); }
        leaving = true;
        at = at || {};
        var shot = pending && pending.anchorHref === url && performance.now() - pending.t < 3000 ? pending.promise : snapshot();
        pending = null;
        document.documentElement.style.cursor = 'progress';
        return shot.then(function (canvas) {
            var rec = {
                t: Date.now(),
                to: url,
                color: pageColor(),
                at: originOf(at.x, at.y),
                params: rippleParams(opts),
                img: canvas ? encode(canvas, opts.quality) : null,
                _canvas: canvas,
            };
            store(sanitize(rec));
            location.assign(url);
            // a download, a 204 or a cancelled navigation leaves us here: let the next click try again
            setTimeout(function () { leaving = false; document.documentElement.style.cursor = ''; }, 2000);
        });
    }
    function sanitize(rec) {
        // _canvas only exists to allow the downscale retry inside store(); never serialized
        Object.defineProperty(rec, '_canvas', { value: rec._canvas, enumerable: false });
        return rec;
    }

    function eligible(a, e) {
        if (!a || !a.href) return false;
        if (e && (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return false;
        var flag = a.closest('[data-ripple]');
        var flagVal = flag && flag.getAttribute('data-ripple');
        if (flagVal === 'off' || flagVal === 'false') return false;
        if (opts.links === 'none') return false;
        if (opts.links === 'flagged' && !flag) return false;
        if (a.hasAttribute('download')) return false;
        var target = a.getAttribute('target');
        if (target && target !== '_self') return false;
        var url;
        try { url = new URL(a.href, location.href); } catch (err) { return false; }
        if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return false;
        // a jump within this page is not a page transition
        if (url.hash && url.pathname === location.pathname && url.search === location.search) return false;
        return true;
    }

    function onPointerDown(e) {
        if (leaving || reducedMotion()) return;
        var a = e.target.closest && e.target.closest('a[href]');
        if (!eligible(a, e)) return;
        // start the snapshot now; the click lands ~100 ms later and the picture is usually ready by then
        pending = { anchorHref: new URL(a.href, location.href).href, promise: snapshot(), t: performance.now() };
    }

    function onClick(e) {
        var a = e.target.closest && e.target.closest('a[href]');
        if (leaving && a) { e.preventDefault(); return; }
        if (!eligible(a, e) || reducedMotion()) return;
        e.preventDefault();
        var keyboard = e.detail === 0; // Enter on a focused link: ripple from the link itself
        var x = e.clientX, y = e.clientY;
        if (keyboard) {
            var r = a.getBoundingClientRect();
            x = r.left + r.width / 2;
            y = r.top + r.height / 2;
        }
        navigate(a.href, { x: x, y: y });
    }

    // ---------- incoming: cover before first paint, then ripple ----------
    function readRecord() {
        var json;
        try {
            json = sessionStorage.getItem(KEY);
            if (json) sessionStorage.removeItem(KEY);
        } catch (e) {
            return null;
        }
        if (!json) return null;
        var rec;
        try { rec = JSON.parse(json); } catch (e) { return null; }
        if (!rec || Date.now() - rec.t > MAX_AGE) return null;
        // a back/forward or reload is not the navigation the snapshot was made for
        var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
        if (nav && nav.type && nav.type !== 'navigate') return null;
        return rec;
    }

    var incoming = readRecord();
    var coverStyle = null;
    if (incoming) {
        // The snapshot goes up as a pseudo-element on <html>, so it is there on the very first paint. The page itself is
        // hidden under it until the ripple's first frame is drawn. Pure-CSS failsafe: both give way after 4 s whatever
        // happens to the script.
        var bg = incoming.img ? 'url("' + incoming.img + '") 0 0/100% 100% no-repeat, ' + incoming.color : incoming.color;
        coverStyle = document.createElement('style');
        coverStyle.setAttribute('data-ripple-ignore', '');
        coverStyle.textContent =
            'html.ripple-fade-in::after{content:"";position:fixed;inset:0;z-index:' + Z + ';pointer-events:none;visibility:visible;' +
            'background:' + bg + ';animation:ripple-fade-failsafe-cover 0s 4s forwards}' +
            'html.ripple-fade-in body{visibility:hidden;animation:ripple-fade-failsafe-body 0s 4s forwards}' +
            '@keyframes ripple-fade-failsafe-cover{to{opacity:0}}' +
            '@keyframes ripple-fade-failsafe-body{to{visibility:visible}}';
        (document.head || document.documentElement).appendChild(coverStyle);
        document.documentElement.classList.add('ripple-fade-in');
    }
    function uncover() {
        document.documentElement.classList.remove('ripple-fade-in');
        if (coverStyle) { coverStyle.remove(); coverStyle = null; }
    }

    function imageFrom(rec) {
        if (rec.img) {
            var img = new Image();
            img.src = rec.img;
            return (img.decode ? img.decode() : new Promise(function (r, j) { img.onload = r; img.onerror = j; })).then(function () { return img; });
        }
        // no picture (the snapshot timed out or failed): ripple from the old page's flat color
        return Promise.resolve(flat(rec.color));
    }

    function startIncoming() {
        if (!incoming) return;
        var rec = incoming;
        incoming = null;
        imageFrom(rec)
            .then(function (img) {
                return play(img, rec.at || { u: 0.5, v: 0.5 }, assign({}, defaults, rec.params), uncover);
            })
            .catch(function (e) {
                if (window.console) console.warn('[RippleFade]', e);
                uncover();
            })
            .then(function () {
                document.dispatchEvent(new CustomEvent('ripplefade:end'));
            });
    }

    // ---------- same-document (SPA) transitions ----------
    function transition(update, at) {
        at = at || {};
        if (reducedMotion()) return Promise.resolve().then(update);
        var origin = originOf(at.x, at.y);
        var params = rippleParams(assign({}, opts, at));
        return snapshot().then(function (canvas) {
            var src = canvas || flat(pageColor());
            // A goes up over the page first, the DOM changes underneath it, then the rings run
            var shown, covered = new Promise(function (r) { shown = r; });
            var changed = covered.then(update);
            var played = play(src, origin, params, shown, changed);
            return Promise.all([changed, played]).then(function (r) { return r[0]; });
        });
    }

    // ---------- wiring ----------
    var wired = false;
    function init(o) {
        assign(opts, o);
        if (!wired) {
            wired = true;
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('click', onClick);
            // back to this page from the bfcache: nothing is leaving any more
            window.addEventListener('pageshow', function (e) {
                if (e.persisted) { leaving = false; pending = null; document.documentElement.style.cursor = ''; }
            });
        }
        preload();
        return api;
    }

    var api = {
        init: init,
        navigate: function (url, at) { return navigate(url, at); },
        transition: transition,
        options: function () { return assign({}, opts); },
        version: '0.1.0',
    };
    window.RippleFade = api;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startIncoming, { once: true });
    else startIncoming();

    if (!(tag && tag.hasAttribute('data-manual'))) init();
})();

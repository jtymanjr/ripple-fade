# RippleFade

A ripple transition: drop a ripple on a surface and it carries image A into image B, ring by ring.

- **Scenarios** (`index.html`): the ripple on water, a phone, a gallery wall, a planet, a full-screen sci-fi console and twin forests. You can switch render styles (ASCII, low-poly dither, topo map, ridgelines, slices) and toggle effects. Built with three.js, loaded from jsDelivr.
- **Simulator** (`simulator.html`): the original 2D RippleFade tuner with sliders, where you can load your own A and B images.
- **Page transitions** (`ripple-fade.js`, demo in `demo/`): a drop-in script that plays the RippleFade between the pages of a site. See below.
- **CSS ripple, no WebGL** (`css-ripple/`): the same ripple without a canvas. The browser snapshots the old view (View Transitions API), animated radial-gradient masks fade it out in rings, highlight and shadow layers light the rings from one side, and an SVG displacement filter driven by small maps baked on click adds the refraction. Add `?light=0` or `?refract=0` to compare. Tested in Chrome; browsers without View Transitions swap pages instantly.

The pages are self-contained HTML files with no build step. Open them directly, or view them on GitHub Pages:

- https://jtymanjr.github.io/ripple-fade/
- https://jtymanjr.github.io/ripple-fade/simulator.html
- https://jtymanjr.github.io/ripple-fade/demo/
- https://jtymanjr.github.io/ripple-fade/css-ripple/

The Experiments section of the Scenarios panel links them all. Controls: click a surface to drop a ripple, press <kbd>Space</kbd> to drop at the centre, and use <kbd>←</kbd> <kbd>→</kbd> to change scenario.

## Page transitions

Add one classic script to the `<head>` of every page:

```html
<script src="ripple-fade.js"></script>
```

From then on every click on a link to another page of the same site ripples from the click point into the next page. To ripple only on chosen links, load it in flagged mode and mark those links (or any element around them) with `data-ripple`:

```html
<script src="ripple-fade.js" data-links="flagged"></script>
<a href="/station" data-ripple>Station</a>
```

`data-ripple="off"` opts a link (or a whole region) out in either mode. Links that open a new tab, downloads, other sites, `#hash` jumps within a page and modified clicks (Ctrl, ⌘, Shift, middle button) always navigate normally, and so does everything when the visitor prefers reduced motion.

### How it works

When a link is clicked, the page photographs its own viewport with [html2canvas-pro](https://github.com/yorickshan/html2canvas-pro) (fetched from jsDelivr while the page is idle, so it is ready before the first click) and leaves the JPEG in `sessionStorage`. The next page reads it from its `<head>` script and puts it up as a cover before its first paint, so the old page appears to stay put. Then the simulator's RippleFade shader runs on a transparent WebGL overlay: the rings refract and fade the old page away and the new, live page shows through behind them. The overlay is removed when the last ring has passed.

The script must be a classic `<script>` in `<head>` (not `defer`, `async` or `type="module"`), because the cover has to be in place before the new page paints.

### Options

Set them as `data-` attributes on the script tag (`data-speed="1.5"`, `data-capture-timeout="600"`), or with `RippleFade.init({...})`. Add `data-manual` to the tag if you want to call `init` yourself. The outgoing page's settings decide how the ripple plays on the next page.

| Option | Default | |
| --- | --- | --- |
| `links` | `all` | `all`, `flagged` or `none` (programmatic only) |
| `rings`, `wavelength`, `speed`, `strength`, `refraction`, `sheen`, `softness` | `2`, `0.245`, `2`, `0.9`, `0.043`, `0.87`, `0.8` | the simulator's sliders, at the tuned values |
| `origin` | `pointer` | `pointer` ripples from the click, `center` from the middle of the screen |
| `captureTimeout` | `900` | ms to wait for the snapshot; after that the page navigates anyway and the ripple starts from the old page's background colour |
| `scale`, `quality` | `min(dpr, 2)`, `0.82` | snapshot pixel ratio and JPEG quality |
| `html2canvas` | jsDelivr URL | where to load html2canvas-pro from (or include it yourself; an existing `window.html2canvas` is used) |
| `capture` | | your own `async (rect) => canvas` instead of html2canvas |
| `reducedMotion` | `skip` | `ignore` to ripple even when the visitor prefers reduced motion |

### From code

```js
RippleFade.navigate('/next', { x, y });                  // a full page load with the ripple
RippleFade.transition(() => renderNextView(), { x, y }); // single-page apps: snapshot, change the DOM, ripple
```

`transition` holds the snapshot over the page while your callback (sync or async) changes the DOM, then ripples into the result. The page fires `ripplefade:end` on `document` when an incoming ripple finishes.

### Limits

- Only the old page is refracted; the new page is live underneath, so it is revealed by the rings but not bent by them.
- The snapshot is html2canvas's rendering of the page, not a real screenshot. Cross-origin images without CORS headers, iframes, video and WebGL canvases (unless created with `preserveDrawingBuffer`) can come out blank in it. Mark anything that photographs badly with `data-ripple-ignore` to leave it out.
- Taking the snapshot holds the navigation briefly (it starts on pointer-down, so usually 100 to 300 ms on a typical page; `captureTimeout` caps it).
- Browser Back and Forward, reloads and form submissions navigate normally.

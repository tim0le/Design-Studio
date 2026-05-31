/*
 * clientExport.js — client-side slide export for the serverless PWA build.
 *
 * On serverless there is no Marp CLI / Chromium / LibreOffice, so PNG/JPG/PDF
 * exports are produced entirely in the browser. PPTX / PPTX-editable are NOT
 * available here (they need the CLI + LibreOffice) and live only on self-host.
 *
 * Globals required (loaded as UMD <script> tags BEFORE this file):
 *   public/vendor/html2canvas.min.js   -> window.html2canvas
 *   public/vendor/jspdf.umd.min.js     -> window.jspdf  (has .jsPDF)
 *
 * Attaches: window.ClientExport
 *
 * All exports target the native 1280x720 slide canvas; PDFs are landscape.
 *
 * The slide argument to every export may be EITHER:
 *   - a DOM element (the rendered 1280x720 <section>, or any node containing it), OR
 *   - the slide <iframe> (rendered via srcdoc, same-origin) — the inner
 *     <section> is resolved from iframe.contentDocument automatically.
 *
 * USAGE (from app.js — this unit does NOT wire any UI):
 *
 *   <script src="/vendor/html2canvas.min.js"></script>
 *   <script src="/vendor/jspdf.umd.min.js"></script>
 *   <script src="/export/clientExport.js"></script>
 *
 *   const iframe = document.querySelector('.slide-frame');   // or a DOM node
 *
 *   // Raster a single slide:
 *   await ClientExport.exportPNG(iframe, 'slide-01.png');
 *   await ClientExport.exportJPG(iframe, 'slide-01.jpg');
 *
 *   // PDF — single slide or an array of slide refs (one landscape page each):
 *   await ClientExport.exportPDF(iframe, 'deck.pdf');
 *   await ClientExport.exportPDF([iframe1, iframe2, iframe3], 'deck.pdf');
 *
 *   // No-dependency, most-reliable-on-iOS fallback — opens a print view:
 *   ClientExport.exportPrintPDF(iframe);             // single
 *   ClientExport.exportPrintPDF([iframe1, iframe2]); // multiple
 */
(function (global) {
  'use strict';

  var SLIDE_W = 1280;
  var SLIDE_H = 720;

  // ── helpers ──────────────────────────────────────────────────────────────

  function isIframe(el) {
    return !!el && typeof el.tagName === 'string' && el.tagName.toUpperCase() === 'IFRAME';
  }

  // Resolve the element we should actually rasterize. If given an <iframe>,
  // reach into its (same-origin, srcdoc) document and grab the inner <section>
  // (falling back to <body>). Throws a clear error if cross-origin access is
  // blocked. If given a plain DOM node, return it (resolving an inner <section>
  // when the node merely contains one).
  function resolveSlideElement(el) {
    if (!el) throw new Error('ClientExport: no slide element/iframe provided');

    if (isIframe(el)) {
      var doc;
      try {
        doc = el.contentDocument || (el.contentWindow && el.contentWindow.document);
      } catch (e) {
        throw new Error(
          'ClientExport: cannot access iframe document (cross-origin). ' +
          'Slides must render same-origin (srcdoc) for client-side export. ' +
          'Original error: ' + e.message
        );
      }
      if (!doc) {
        throw new Error(
          'ClientExport: iframe has no accessible document yet. ' +
          'Ensure the slide has finished rendering before exporting.'
        );
      }
      var section = doc.querySelector('section');
      var target = section || doc.body;
      if (!target) {
        throw new Error('ClientExport: iframe document has no <section> or <body> to render');
      }
      return target;
    }

    // Plain DOM node: prefer an inner <section> if present, else the node itself.
    if (typeof el.querySelector === 'function') {
      if (el.tagName && el.tagName.toUpperCase() === 'SECTION') return el;
      var inner = el.querySelector('section');
      if (inner) return inner;
    }
    return el;
  }

  function requireHtml2Canvas() {
    if (typeof global.html2canvas !== 'function') {
      throw new Error(
        'ClientExport: window.html2canvas is not loaded. ' +
        'Include /vendor/html2canvas.min.js before clientExport.js.'
      );
    }
    return global.html2canvas;
  }

  function requireJsPDF() {
    var ns = global.jspdf;
    var Ctor = ns && ns.jsPDF;
    if (typeof Ctor !== 'function') {
      throw new Error(
        'ClientExport: window.jspdf.jsPDF is not loaded. ' +
        'Include /vendor/jspdf.umd.min.js before clientExport.js.'
      );
    }
    return Ctor;
  }

  // Rasterize a resolved slide element to a canvas sized to the native slide.
  // The element may be displayed scaled (fit-to-width on mobile); we compute the
  // scale that maps its current rendered width back to the native 1280 canvas so
  // html2canvas produces a full-resolution 1280x720 bitmap regardless of zoom.
  function renderToCanvas(slideEl) {
    var h2c = requireHtml2Canvas();
    var el = resolveSlideElement(slideEl);

    var rect = (typeof el.getBoundingClientRect === 'function')
      ? el.getBoundingClientRect()
      : { width: SLIDE_W, height: SLIDE_H };
    var srcW = rect.width || SLIDE_W;
    var scale = SLIDE_W / srcW;

    return h2c(el, {
      width: SLIDE_W / scale,
      height: SLIDE_H / scale,
      windowWidth: SLIDE_W / scale,
      windowHeight: SLIDE_H / scale,
      scale: scale,
      backgroundColor: null,
      useCORS: true,
      logging: false
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      if (typeof canvas.toBlob === 'function') {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('ClientExport: canvas.toBlob produced no blob'));
        }, mime, quality);
      } else {
        // Fallback for environments without toBlob: decode the data URL.
        try {
          var dataUrl = canvas.toDataURL(mime, quality);
          var byteString = atob(dataUrl.split(',')[1]);
          var len = byteString.length;
          var bytes = new Uint8Array(len);
          for (var i = 0; i < len; i++) bytes[i] = byteString.charCodeAt(i);
          resolve(new Blob([bytes], { type: mime }));
        } catch (e) {
          reject(e);
        }
      }
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = global.document.createElement('a');
    a.href = url;
    a.download = filename || 'slide';
    a.style.display = 'none';
    global.document.body.appendChild(a);
    a.click();
    global.document.body.removeChild(a);
    // Revoke after the click has been processed.
    global.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ── PNG / JPG ─────────────────────────────────────────────────────────────

  function exportRaster(slideEl, filename, mime, quality, defaultName) {
    return renderToCanvas(slideEl)
      .then(function (canvas) {
        return canvasToBlob(canvas, mime, quality);
      })
      .then(function (blob) {
        triggerDownload(blob, filename || defaultName);
        return blob;
      });
  }

  function exportPNG(slideEl, filename) {
    return exportRaster(slideEl, filename, 'image/png', undefined, 'slide.png');
  }

  function exportJPG(slideEl, filename) {
    return exportRaster(slideEl, filename, 'image/jpeg', 0.92, 'slide.jpg');
  }

  // ── PDF (html2canvas + jsPDF) ─────────────────────────────────────────────

  // Accepts a single slide ref or an array. One 1280x720 landscape page each.
  function exportPDF(slideElOrArray, filename) {
    var JsPDF = requireJsPDF();
    var slides = Array.isArray(slideElOrArray) ? slideElOrArray : [slideElOrArray];
    if (slides.length === 0) {
      return Promise.reject(new Error('ClientExport: no slides provided to exportPDF'));
    }

    // jsPDF unit "px" with a [1280,720] page maps the canvas 1:1.
    var pdf = new JsPDF({
      orientation: 'landscape',
      unit: 'px',
      format: [SLIDE_W, SLIDE_H]
    });

    // Render slides sequentially so we don't thrash memory with N parallel
    // html2canvas passes, and so pages stay in order.
    var chain = Promise.resolve();
    slides.forEach(function (slideEl, i) {
      chain = chain.then(function () {
        return renderToCanvas(slideEl).then(function (canvas) {
          var imgData = canvas.toDataURL('image/png');
          if (i > 0) pdf.addPage([SLIDE_W, SLIDE_H], 'landscape');
          pdf.addImage(imgData, 'PNG', 0, 0, SLIDE_W, SLIDE_H);
        });
      });
    });

    return chain.then(function () {
      pdf.save(filename || 'deck.pdf');
      return pdf;
    });
  }

  // ── Print fallback (no dependencies; most reliable on iOS Safari) ──────────

  // Opens a print-optimized window with each slide as a full landscape page and
  // calls window.print(). The user picks "Save as PDF" from the system dialog.
  // This is the recommended path on iOS Safari, where html2canvas/jsPDF can be
  // unreliable for large/complex slides.
  function exportPrintPDF(slideElOrArray) {
    var slides = Array.isArray(slideElOrArray) ? slideElOrArray : [slideElOrArray];
    if (slides.length === 0) {
      throw new Error('ClientExport: no slides provided to exportPrintPDF');
    }

    var bodies = slides.map(function (slideEl) {
      var el = resolveSlideElement(slideEl);
      return el.outerHTML;
    }).join('\n');

    // Pull any <style>/<link> from the first slide's source document so the
    // printed output keeps the theme CSS. For iframe srcdoc renders this is the
    // iframe's own <head>; for plain nodes we fall back to the host document.
    var headStyles = '';
    try {
      var first = slides[0];
      var srcDoc = isIframe(first)
        ? (first.contentDocument || (first.contentWindow && first.contentWindow.document))
        : global.document;
      if (srcDoc && srcDoc.head) {
        srcDoc.querySelectorAll('style, link[rel="stylesheet"]').forEach(function (node) {
          headStyles += node.outerHTML;
        });
      }
    } catch (e) {
      // Cross-origin or no head — print unstyled rather than failing outright.
      headStyles = '';
    }

    var win = global.open('', '_blank');
    if (!win) {
      throw new Error(
        'ClientExport: could not open a print window (popup blocked). ' +
        'Allow popups for this site to use the print/PDF export.'
      );
    }

    // A <base> so any relative <link href> copied from the slide's <head>
    // resolves against the app origin rather than the about:blank print window.
    var baseHref = '';
    try { baseHref = global.location && global.location.href ? global.location.href : ''; } catch (e) { baseHref = ''; }

    var html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      (baseHref ? '<base href="' + baseHref + '">' : '') +
      '<title>Print slides</title>' +
      headStyles +
      '<style>' +
      '@page { size: ' + SLIDE_W + 'px ' + SLIDE_H + 'px landscape; margin: 0; }' +
      'html,body { margin:0; padding:0; }' +
      'section { width:' + SLIDE_W + 'px; height:' + SLIDE_H + 'px; ' +
      'page-break-after: always; break-after: page; overflow:hidden; }' +
      'section:last-child { page-break-after: auto; break-after: auto; }' +
      '</style></head><body>' + bodies + '</body></html>';

    win.document.open();
    win.document.write(html);
    win.document.close();

    // Print exactly once: whichever of the 'load' event or the timeout fallback
    // fires first wins. Without this guard both can fire (load completes within
    // the timeout for simple slides) and the user gets two print dialogs.
    var printed = false;
    function printOnce() {
      if (printed) return;
      printed = true;
      try { win.focus(); win.print(); } catch (e) { /* user closed window */ }
    }
    // Wait for layout/fonts before printing.
    win.addEventListener('load', printOnce);
    // Fallback in case 'load' already fired (e.g. document.write content).
    global.setTimeout(printOnce, 500);

    return win;
  }

  global.ClientExport = {
    SLIDE_W: SLIDE_W,
    SLIDE_H: SLIDE_H,
    resolveSlideElement: resolveSlideElement,
    exportPNG: exportPNG,
    exportJPG: exportJPG,
    exportPDF: exportPDF,
    exportPrintPDF: exportPrintPDF
  };
})(typeof window !== 'undefined' ? window : this);

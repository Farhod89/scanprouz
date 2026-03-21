import React, { useEffect, useMemo, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { jsPDF } from 'jspdf';
import Tesseract from 'tesseract.js';
import CropModal from './CropModal';

const STORAGE_KEYS = {
  docs: 'scanprouz_docs_v2',
  activeDocId: 'scanprouz_active_doc_v2',
  activePageId: 'scanprouz_active_page_v2',
  view: 'scanprouz_view_v2',
  settings: 'scanprouz_settings_v2',
};

const defaultSettings = {
  mode: 'grayscale',
  brightness: 6,
  contrast: 22,
  threshold: 165,
  rotation: 0,
  autoCrop: true,
};

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return value;
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function dataURLToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function getContext2D(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

function cloneCanvas(source) {
  const c = document.createElement('canvas');
  c.width = source.width;
  c.height = source.height;
  getContext2D(c).drawImage(source, 0, 0);
  return c;
}


async function normalizeImageDataUrl(dataUrl, maxSide = 1800, quality = 0.92) {
  const img = await dataURLToImage(dataUrl);
  const longest = Math.max(img.width, img.height);
  if (longest <= maxSide) return dataUrl;
  const scale = maxSide / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  getContext2D(canvas).drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

function imageStats(imageData) {
  const data = imageData.data;
  let white = 0;
  let black = 0;
  for (let i = 0; i < data.length; i += 4) {
    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (avg > 245) white += 1;
    if (avg < 10) black += 1;
  }
  const total = data.length / 4;
  return { whiteRatio: white / total, blackRatio: black / total };
}

function trimWhiteMargins(sourceCanvas) {
  const previewW = Math.min(480, sourceCanvas.width);
  const previewH = Math.max(1, Math.round((sourceCanvas.height / sourceCanvas.width) * previewW));
  const preview = document.createElement('canvas');
  preview.width = previewW;
  preview.height = previewH;
  const pctx = getContext2D(preview);
  pctx.drawImage(sourceCanvas, 0, 0, previewW, previewH);

  const { data } = pctx.getImageData(0, 0, previewW, previewH);
  const rowDarkRatio = new Array(previewH).fill(0);
  const colDarkRatio = new Array(previewW).fill(0);

  for (let y = 0; y < previewH; y++) {
    let rowDark = 0;
    for (let x = 0; x < previewW; x++) {
      const i = (y * previewW + x) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const isDark = gray < 225 ? 1 : 0;
      rowDark += isDark;
      colDarkRatio[x] += isDark;
    }
    rowDarkRatio[y] = rowDark / previewW;
  }

  for (let x = 0; x < previewW; x++) {
    colDarkRatio[x] /= previewH;
  }

  const rowThreshold = 0.015;
  const colThreshold = 0.015;
  let top = 0;
  while (top < previewH * 0.25 && rowDarkRatio[top] < rowThreshold) top += 1;
  let bottom = previewH - 1;
  while (bottom > previewH * 0.75 && rowDarkRatio[bottom] < rowThreshold) bottom -= 1;
  let left = 0;
  while (left < previewW * 0.25 && colDarkRatio[left] < colThreshold) left += 1;
  let right = previewW - 1;
  while (right > previewW * 0.75 && colDarkRatio[right] < colThreshold) right -= 1;

  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  const areaRatio = (cropW * cropH) / (previewW * previewH);

  if (cropW < previewW * 0.55 || cropH < previewH * 0.55 || areaRatio < 0.55) {
    return sourceCanvas;
  }

  const sx = Math.max(0, Math.round((left / previewW) * sourceCanvas.width));
  const sy = Math.max(0, Math.round((top / previewH) * sourceCanvas.height));
  const sw = Math.min(sourceCanvas.width - sx, Math.round((cropW / previewW) * sourceCanvas.width));
  const sh = Math.min(sourceCanvas.height - sy, Math.round((cropH / previewH) * sourceCanvas.height));

  if (sw < sourceCanvas.width * 0.55 || sh < sourceCanvas.height * 0.55) {
    return sourceCanvas;
  }

  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  getContext2D(out).drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out;
}

function rotateToCanvas(img, rotation) {
  const normalized = ((rotation % 360) + 360) % 360;
  const canvas = document.createElement('canvas');
  const ctx = getContext2D(canvas);
  if (normalized === 90 || normalized === 270) {
    canvas.width = img.height;
    canvas.height = img.width;
  } else {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((normalized * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
  return canvas;
}

function applyEnhancement(inputCanvas, options) {
  const canvas = cloneCanvas(inputCanvas);
  const ctx = getContext2D(canvas);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const contrast = clamp(options.contrast ?? 0, -100, 100);
  const brightness = clamp(options.brightness ?? 0, -100, 100);
  const threshold = clamp(options.threshold ?? 160, 0, 255);
  const contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;

    if (options.mode === 'grayscale' || options.mode === 'bw') {
      r = g = b = gray;
    }

    r = clamp((r - 128) * contrastFactor + 128 + brightness, 0, 255);
    g = clamp((g - 128) * contrastFactor + 128 + brightness, 0, 255);
    b = clamp((b - 128) * contrastFactor + 128 + brightness, 0, 255);

    if (options.mode === 'bw') {
      gray = 0.299 * r + 0.587 * g + 0.114 * b;
      const val = gray > threshold ? 255 : 0;
      r = g = b = val;
    }

    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

async function processImage(dataUrl, options) {
  const normalizedUrl = await normalizeImageDataUrl(dataUrl);
  const img = await dataURLToImage(normalizedUrl);
  const rotated = rotateToCanvas(img, options.rotation || 0);
  const cropped = options.autoCrop ? trimWhiteMargins(rotated) : rotated;
  const enhanced = applyEnhancement(cropped, options);

  if (options.mode === 'bw') {
    const stats = imageStats(getContext2D(enhanced).getImageData(0, 0, enhanced.width, enhanced.height));
    if (stats.whiteRatio > 0.97 || stats.blackRatio > 0.97) {
      const safer = applyEnhancement(cropped, { ...options, mode: 'grayscale' });
      return { original: normalizedUrl, scanned: safer.toDataURL('image/jpeg', 0.95), fallback: 'bw-to-grayscale' };
    }
  }

  const safeStats = imageStats(getContext2D(enhanced).getImageData(0, 0, enhanced.width, enhanced.height));
  if (safeStats.whiteRatio > 0.995 || enhanced.width < 40 || enhanced.height < 40) {
    return { original: normalizedUrl, scanned: rotated.toDataURL('image/jpeg', 0.95), fallback: 'too-white' };
  }

  return { original: normalizedUrl, scanned: enhanced.toDataURL('image/jpeg', 0.95), fallback: null };
}

async function processImageSafe(dataUrl, options) {
  try {
    return await processImage(dataUrl, options);
  } catch (error) {
    console.error('processImageSafe fallback', error);
    const normalizedUrl = await normalizeImageDataUrl(dataUrl).catch(() => dataUrl);
    return { original: normalizedUrl, scanned: normalizedUrl, fallback: 'error' };
  }
}


async function cropDataUrl(dataUrl, crop) {
  const img = await dataURLToImage(dataUrl);
  const sx = Math.max(0, Math.floor(img.width * crop.left));
  const sy = Math.max(0, Math.floor(img.height * crop.top));
  const ex = Math.min(img.width, Math.ceil(img.width * crop.right));
  const ey = Math.min(img.height, Math.ceil(img.height * crop.bottom));
  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  getContext2D(canvas).drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas.toDataURL('image/jpeg', 0.95);
}

function emptyDoc(name = 'Document') {
  return {
    id: uid(),
    name,
    createdAt: new Date().toISOString(),
    pages: [],
  };
}

function migrateLegacyPages() {
  try {
    const docsRaw = localStorage.getItem(STORAGE_KEYS.docs);
    if (docsRaw) return JSON.parse(docsRaw);

    const pagesRaw = localStorage.getItem('scanprouz_pages');
    if (!pagesRaw) return [];
    const pages = JSON.parse(pagesRaw);
    if (!Array.isArray(pages) || !pages.length) return [];
    const migrated = [{ ...emptyDoc(localStorage.getItem('scanprouz_doc_name') || 'Document'), pages }];
    localStorage.setItem(STORAGE_KEYS.docs, JSON.stringify(migrated));
    return migrated;
  } catch {
    return [];
  }
}

export default function App() {
  const webcamRef = useRef(null);
  const uploadRef = useRef(null);

  const [documents, setDocuments] = useState(() => migrateLegacyPages());
  const [activeDocId, setActiveDocId] = useState(() => localStorage.getItem(STORAGE_KEYS.activeDocId) || null);
  const [activePageId, setActivePageId] = useState(() => localStorage.getItem(STORAGE_KEYS.activePageId) || null);
  const [view, setView] = useState(() => localStorage.getItem(STORAGE_KEYS.view) || 'list');
  const [showCamera, setShowCamera] = useState(false);
  const [showCrop, setShowCrop] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState('');
  const [ocrText, setOcrText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [settings, setSettings] = useState(() => {
    try {
      return { ...defaultSettings, ...(JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}')) };
    } catch {
      return defaultSettings;
    }
  });

  const activeDoc = useMemo(() => documents.find((d) => d.id === activeDocId) || null, [documents, activeDocId]);
  const activePage = useMemo(() => activeDoc?.pages.find((p) => p.id === activePageId) || activeDoc?.pages[0] || null, [activeDoc, activePageId]);

  useEffect(() => { localStorage.setItem(STORAGE_KEYS.docs, JSON.stringify(documents)); }, [documents]);
  useEffect(() => {
    if (activeDocId) localStorage.setItem(STORAGE_KEYS.activeDocId, activeDocId);
    else localStorage.removeItem(STORAGE_KEYS.activeDocId);
  }, [activeDocId]);
  useEffect(() => {
    if (activePageId) localStorage.setItem(STORAGE_KEYS.activePageId, activePageId);
    else localStorage.removeItem(STORAGE_KEYS.activePageId);
  }, [activePageId]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.view, view); }, [view]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings)); }, [settings]);
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(t); }, [notice]);
  useEffect(() => {
    if (!documents.length) {
      setActiveDocId(null);
      setActivePageId(null);
      setView('list');
      return;
    }
    if (!activeDocId || !documents.some((d) => d.id === activeDocId)) {
      setActiveDocId(documents[0].id);
    }
  }, [documents, activeDocId]);
  useEffect(() => {
    if (activeDoc?.pages?.length) {
      if (!activePageId || !activeDoc.pages.some((p) => p.id === activePageId)) {
        setActivePageId(activeDoc.pages[0].id);
      }
    } else {
      setActivePageId(null);
    }
  }, [activeDoc, activePageId]);

  function createNewDocument(name = `Document ${documents.length + 1}`) {
    const doc = emptyDoc(name);
    setDocuments((prev) => [doc, ...prev]);
    setActiveDocId(doc.id);
    setActivePageId(null);
    setView('pages');
    return doc;
  }

  function createDocumentWithPage(page, name = `Document ${documents.length + 1}`) {
    const doc = { ...emptyDoc(name), pages: [page] };
    setDocuments((prev) => [doc, ...prev]);
    setActiveDocId(doc.id);
    setActivePageId(page.id);
    setView('pages');
    return doc;
  }

  function updateDocument(docId, updater) {
    setDocuments((prev) => prev.map((doc) => (doc.id === docId ? updater(doc) : doc)));
  }

  async function addPageToDocument(dataUrl, docId) {
    setProcessing(true);
    try {
      const result = await processImageSafe(dataUrl, settings);
      const page = {
        id: uid(),
        original: result.original,
        scanned: result.scanned,
        createdAt: new Date().toISOString(),
      };

      let resolvedDocId = docId;
      if (docId) {
        updateDocument(docId, (doc) => ({ ...doc, pages: [...doc.pages, page] }));
        setActiveDocId(docId);
      } else if (activeDocId && activeDoc?.pages?.length) {
        resolvedDocId = activeDocId;
        updateDocument(activeDocId, (doc) => ({ ...doc, pages: [...doc.pages, page] }));
        setActiveDocId(activeDocId);
      } else {
        const created = createDocumentWithPage(page);
        resolvedDocId = created.id;
      }

      setActivePageId(page.id);
      setView('pages');
      if (result.fallback) {
        setNotice('Rasm xavfsiz rejimda saqlandi.');
      }
      return { page, docId: resolvedDocId };
    } finally {
      setProcessing(false);
    }
  }

  async function capture() {
    const shot = webcamRef.current?.getScreenshot();
    if (shot) {
      await addPageToDocument(shot, activeDoc?.pages?.length ? activeDocId : null);
      setShowCamera(false);
    }
  }

  async function onUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    let targetDocId = activeDoc?.pages?.length ? activeDocId : null;
    for (const file of files) {
      const reader = new FileReader();
      await new Promise((resolve) => {
        reader.onload = async () => {
          const outcome = await addPageToDocument(String(reader.result), targetDocId);
          if (!targetDocId && outcome?.docId) {
            targetDocId = outcome.docId;
          } else if (!targetDocId && !outcome?.docId) {
            const docsRaw = JSON.parse(localStorage.getItem(STORAGE_KEYS.docs) || '[]');
            targetDocId = docsRaw[0]?.id || null;
          }
          resolve();
        };
        reader.onerror = () => { setNotice('Faylni o‘qib bo‘lmadi.'); resolve(); };
        reader.readAsDataURL(file);
      });
    }
    e.target.value = '';
  }

  async function reprocessActive() {
    if (!activeDoc || !activePage) return;
    setProcessing(true);
    try {
      const result = await processImageSafe(activePage.original, settings);
      updateDocument(activeDoc.id, (doc) => ({
        ...doc,
        pages: doc.pages.map((page) => (page.id === activePage.id ? { ...page, original: result.original, scanned: result.scanned } : page)),
      }));
      if (result.fallback) setNotice('Rasm xavfsiz rejimda qayta ishladi.');
    } finally {
      setProcessing(false);
    }
  }

  function removePage(docId, pageId) {
    updateDocument(docId, (doc) => ({ ...doc, pages: doc.pages.filter((p) => p.id !== pageId) }));
  }

  function removeDocument(docId) {
    setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
    if (activeDocId === docId) {
      setActiveDocId(null);
      setActivePageId(null);
    }
  }


  function openManualCrop() {
    if (!activePage) return;
    setShowCrop(true);
  }

  async function applyManualCrop(crop) {
    if (!activeDoc || !activePage) return;
    setProcessing(true);
    setShowCrop(false);
    try {
      const croppedOriginal = await cropDataUrl(activePage.original, crop);
      const result = await processImageSafe(croppedOriginal, { ...settings, autoCrop: false });
      updateDocument(activeDoc.id, (doc) => ({
        ...doc,
        pages: doc.pages.map((page) => (page.id === activePage.id
          ? { ...page, original: result.original, scanned: result.scanned, croppedAt: new Date().toISOString() }
          : page)),
      }));
      setNotice('Qo‘lda crop saqlandi.');
    } finally {
      setProcessing(false);
    }
  }

  async function exportPdf(doc = activeDoc) {
    if (!doc?.pages?.length) return;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    for (let i = 0; i < doc.pages.length; i += 1) {
      const img = await dataURLToImage(doc.pages[i].scanned);
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const ratio = Math.min(pageWidth / img.width, pageHeight / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;
      const x = (pageWidth - w) / 2;
      const y = (pageHeight - h) / 2;
      if (i > 0) pdf.addPage();
      pdf.addImage(doc.pages[i].scanned, 'JPEG', x, y, w, h);
    }
    pdf.save(`${doc.name || 'Document'}.pdf`);
  }

  async function runOCR() {
    if (!activePage) return;
    setOcrLoading(true);
    setOcrProgress(0);
    setOcrText('');
    try {
      const result = await Tesseract.recognize(activePage.scanned, 'eng+rus', {
        logger: (m) => {
          if (m.status === 'recognizing text' && typeof m.progress === 'number') {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      setOcrText(result.data.text || 'Matn topilmadi');
    } catch {
      setOcrText('OCR ishlamadi. Yana urinib ko‘ring.');
    } finally {
      setOcrLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" onClick={() => setView('list')}>
          <div className="brand-icon brand-icon-image"><img src="/logo.svg" alt="ScanProUz" /></div>
          <div>
            <div className="brand-title">ScanProUz</div>
            <div className="brand-subtitle">Scanner v4</div>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="icon-btn" onClick={() => setView('settings')}>⚙</button>
        </div>
      </header>

      <main className="main-layout">
        {notice && <div className="notice">{notice}</div>}
        {view === 'list' && (
          <section className="list-screen">
            <div className="section-head">
              <div>
                <h1>Hujjatlar</h1>
                <p>TurboScan uslubidagi ro‘yxat, qo‘lda crop va xavfsiz qayta ishlash.</p>
              </div>
            </div>

            <div className="doc-list">
              {documents.length === 0 && (
                <div className="empty-card">
                  <h3>Hali hujjat yo‘q</h3>
                  <p>Kamera yoki galereya orqali birinchi skanni qo‘shing.</p>
                </div>
              )}

              {documents.map((doc) => (
                <div key={doc.id} className="doc-row" onClick={() => { setActiveDocId(doc.id); setView('pages'); }}>
                  <img className="doc-thumb" src={doc.pages[0]?.scanned || ''} alt="thumb" />
                  <div className="doc-meta">
                    <div className="doc-title-row">
                      <strong>{doc.name}</strong>
                      {doc.pages.length > 1 && <span className="page-badge">{doc.pages.length}</span>}
                    </div>
                    <span>{formatDate(doc.createdAt)}</span>
                  </div>
                  <div className="doc-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="mini-btn" onClick={() => exportPdf(doc)}>PDF</button>
                    <button className="mini-btn danger" onClick={() => removeDocument(doc.id)}>✕</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="floating-actions">
              <button className="fab" onClick={() => { setShowCamera(true); }}>📷</button>
              <button className="fab secondary" onClick={() => uploadRef.current?.click()}>🖼️</button>
              <button className="fab secondary" onClick={() => { const doc = createNewDocument(); setActiveDocId(doc.id); setView('pages'); setNotice('Yangi hujjat yaratildi. Endi sahifa qo‘shing.'); }}>📄</button>
            </div>
          </section>
        )}

        {view === 'pages' && activeDoc && (
          <section className="pages-screen">
            <div className="section-head sticky-head">
              <button className="back-btn" onClick={() => setView('list')}>←</button>
              <div className="doc-head-center">
                <input
                  className="title-input"
                  value={activeDoc.name}
                  onChange={(e) => updateDocument(activeDoc.id, (doc) => ({ ...doc, name: e.target.value }))}
                />
                <span>{activeDoc.pages.length} sahifa • {formatDate(activeDoc.createdAt)}</span>
              </div>
              <button className="icon-btn" onClick={() => exportPdf(activeDoc)}>PDF</button>
            </div>

            <div className="pages-layout">
              <div className="page-preview-card">
                {activePage ? <img className="page-preview" src={activePage.scanned} alt="scan" /> : <div className="empty-card"><h3>Sahifa yo‘q</h3><p>Galereya yoki kamera orqali sahifa qo‘shing.</p></div>}
                {processing && <div className="processing-overlay">Ishlanmoqda…</div>}
              </div>

              <aside className="editor-side">
                <div className="thumb-column">
                  {activeDoc.pages.map((page, index) => (
                    <div key={page.id} className={`page-thumb-row ${page.id === activePage?.id ? 'active' : ''}`} onClick={() => setActivePageId(page.id)}>
                      <span>{index + 1}.</span>
                      <img src={page.scanned} alt="page" />
                      <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); removePage(activeDoc.id, page.id); }}>✕</button>
                    </div>
                  ))}
                </div>

                <div className="tools-card">
                  <div className="tool-grid">
                    <label>
                      Rejim
                      <select className="input" value={settings.mode} onChange={(e) => setSettings((s) => ({ ...s, mode: e.target.value }))}>
                        <option value="color">Rangli</option>
                        <option value="grayscale">Kulrang</option>
                        <option value="bw">Oq-qora</option>
                      </select>
                    </label>
                    <label>
                      Burish
                      <select className="input" value={settings.rotation} onChange={(e) => setSettings((s) => ({ ...s, rotation: Number(e.target.value) }))}>
                        <option value="0">0°</option>
                        <option value="90">90°</option>
                        <option value="180">180°</option>
                        <option value="270">270°</option>
                      </select>
                    </label>
                  </div>

                  <label className="toggle-row">
                    <input type="checkbox" checked={settings.autoCrop} onChange={(e) => setSettings((s) => ({ ...s, autoCrop: e.target.checked }))} />
                    Xavfsiz auto-crop
                  </label>

                  <label>
                    Yorqinlik: {settings.brightness}
                    <input className="range" type="range" min="-20" max="30" value={settings.brightness} onChange={(e) => setSettings((s) => ({ ...s, brightness: Number(e.target.value) }))} />
                  </label>
                  <label>
                    Kontrast: {settings.contrast}
                    <input className="range" type="range" min="0" max="60" value={settings.contrast} onChange={(e) => setSettings((s) => ({ ...s, contrast: Number(e.target.value) }))} />
                  </label>
                  <label>
                    Threshold: {settings.threshold}
                    <input className="range" type="range" min="100" max="220" value={settings.threshold} onChange={(e) => setSettings((s) => ({ ...s, threshold: Number(e.target.value) }))} />
                  </label>

                  <div className="tool-actions">
                    <button className="btn primary" onClick={reprocessActive} disabled={!activePage || processing}>Qayta ishlash</button>
                    <button className="btn" onClick={openManualCrop} disabled={!activePage || processing}>Crop</button>
                    <button className="btn" onClick={() => setShowCamera(true)}>Kamera</button>
                    <button className="btn" onClick={() => uploadRef.current?.click()}>Galereya</button>
                    <button className="btn" onClick={runOCR} disabled={!activePage || ocrLoading}>{ocrLoading ? `${ocrProgress}%` : 'OCR'}</button>
                  </div>
                </div>
              </aside>
            </div>

            {ocrText && <textarea className="ocr-box" value={ocrText} readOnly />}
          </section>
        )}

        {view === 'settings' && (
          <section className="settings-screen">
            <div className="section-head sticky-head">
              <button className="back-btn" onClick={() => setView(documents.length ? 'pages' : 'list')}>←</button>
              <div className="doc-head-center">
                <h2>Sozlamalar</h2>
                <span>Barqaror v2</span>
              </div>
            </div>
            <div className="settings-list">
              <div className="settings-item"><strong>Default filter</strong><span>{settings.mode}</span></div>
              <div className="settings-item"><strong>OCR tillari</strong><span>eng + rus</span></div>
              <div className="settings-item"><strong>PDF o‘lchami</strong><span>A4</span></div>
              <div className="settings-item"><strong>Auto-crop</strong><span>{settings.autoCrop ? 'yoqilgan' : 'o‘chirilgan'}</span></div>
              <div className="settings-note">Play Market uchun hali Android wrapper va privacy policy kerak bo‘ladi. Web/PWA qismi kuchaytirildi.</div>
            </div>
          </section>
        )}
      </main>

      {showCamera && (
        <div className="modal-backdrop" onClick={() => setShowCamera(false)}>
          <div className="camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="camera-head">
              <strong>Kamera</strong>
              <button className="icon-btn" onClick={() => setShowCamera(false)}>✕</button>
            </div>
            <Webcam
              ref={webcamRef}
              className="webcam"
              audio={false}
              mirrored={false}
              screenshotFormat="image/jpeg"
              videoConstraints={{ facingMode: { ideal: 'environment' } }}
            />
            <div className="tool-actions">
              <button className="btn primary" onClick={capture}>Rasm olish</button>
            </div>
          </div>
        </div>
      )}


      {showCrop && activePage && (
        <CropModal
          imageSrc={activePage.original}
          title="Qo‘lda crop"
          onClose={() => setShowCrop(false)}
          onSave={applyManualCrop}
        />
      )}

      <input ref={uploadRef} className="hidden" type="file" accept="image/*" multiple onChange={onUpload} />
    </div>
  );
}

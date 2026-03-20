import React, { useEffect, useMemo, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { jsPDF } from 'jspdf';
import Tesseract from 'tesseract.js';

const STORAGE_KEYS = {
  documents: 'scanprouz_documents_v2',
  legacyPages: 'scanprouz_pages',
  isPro: 'scanprouz_is_pro',
  settings: 'scanprouz_settings_v2',
};

const DEFAULT_FILTER = {
  grayscale: false,
  blackWhite: true,
  threshold: 160,
  brightness: 8,
  contrast: 60,
  rotation: 0,
  autoCrop: true,
};

const DEFAULT_SETTINGS = {
  autoColor: true,
  autoPageSize: true,
  fileNameByDate: false,
  pdfSize: 'A4',
  colorTheme: 'Ko‘k',
};

function formatUzDate(value) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function createDocument(name = 'Document') {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    pages: [],
  };
}

function normalizeDocuments(rawDocuments, legacyPages) {
  if (Array.isArray(rawDocuments) && rawDocuments.length) return rawDocuments;
  if (Array.isArray(legacyPages) && legacyPages.length) {
    const doc = createDocument('ScanProUz-hujjat');
    doc.pages = legacyPages;
    doc.updatedAt = legacyPages[legacyPages.length - 1]?.createdAt || doc.createdAt;
    return [doc];
  }
  return [];
}

function dataURLToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeCropCanvas(sourceCanvas) {
  const previewW = Math.min(320, sourceCanvas.width);
  const previewH = Math.max(1, Math.round((sourceCanvas.height / sourceCanvas.width) * previewW));
  const preview = document.createElement('canvas');
  preview.width = previewW;
  preview.height = previewH;
  const pctx = preview.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(sourceCanvas, 0, 0, previewW, previewH);
  const pixels = pctx.getImageData(0, 0, previewW, previewH).data;

  const rowStrength = new Array(previewH).fill(0);
  const colStrength = new Array(previewW).fill(0);

  for (let y = 1; y < previewH - 1; y++) {
    for (let x = 1; x < previewW - 1; x++) {
      const i = (y * previewW + x) * 4;
      const up = ((y - 1) * previewW + x) * 4;
      const left = (y * previewW + (x - 1)) * 4;
      const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      const grayUp = 0.299 * pixels[up] + 0.587 * pixels[up + 1] + 0.114 * pixels[up + 2];
      const grayLeft = 0.299 * pixels[left] + 0.587 * pixels[left + 1] + 0.114 * pixels[left + 2];
      const edge = Math.abs(gray - grayUp) + Math.abs(gray - grayLeft);
      const brightBoost = gray > 145 ? 0.4 : 0;
      const score = edge + brightBoost * gray;
      rowStrength[y] += score;
      colStrength[x] += score;
    }
  }

  const avgRow = rowStrength.reduce((a, b) => a + b, 0) / Math.max(1, rowStrength.length);
  const avgCol = colStrength.reduce((a, b) => a + b, 0) / Math.max(1, colStrength.length);
  const rowThreshold = avgRow * 0.62;
  const colThreshold = avgCol * 0.62;

  let top = rowStrength.findIndex((v) => v > rowThreshold);
  let bottom = rowStrength.length - 1 - [...rowStrength].reverse().findIndex((v) => v > rowThreshold);
  let left = colStrength.findIndex((v) => v > colThreshold);
  let right = colStrength.length - 1 - [...colStrength].reverse().findIndex((v) => v > colThreshold);

  if (top < 0 || left < 0 || bottom <= top || right <= left) {
    return sourceCanvas;
  }

  const padX = Math.round(previewW * 0.03);
  const padY = Math.round(previewH * 0.03);
  left = clamp(left - padX, 0, previewW - 1);
  right = clamp(right + padX, 0, previewW - 1);
  top = clamp(top - padY, 0, previewH - 1);
  bottom = clamp(bottom + padY, 0, previewH - 1);

  const sx = Math.round((left / previewW) * sourceCanvas.width);
  const sy = Math.round((top / previewH) * sourceCanvas.height);
  const sw = Math.round(((right - left) / previewW) * sourceCanvas.width);
  const sh = Math.round(((bottom - top) / previewH) * sourceCanvas.height);

  const cropAreaRatio = (sw * sh) / (sourceCanvas.width * sourceCanvas.height);
  if (
    sw < 80 ||
    sh < 80 ||
    cropAreaRatio < 0.18 ||
    cropAreaRatio > 0.98 ||
    sw >= sourceCanvas.width ||
    sh >= sourceCanvas.height
  ) {
    return sourceCanvas;
  }

  const cropped = document.createElement('canvas');
  cropped.width = sw;
  cropped.height = sh;
  const cctx = cropped.getContext('2d');
  cctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

async function processImage(dataUrl, options) {
  const img = await dataURLToImage(dataUrl);
  let canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d', { willReadFrequently: true });
  canvas.width = img.width;
  canvas.height = img.height;

  ctx.save();
  if (options.rotation !== 0) {
    const rad = (options.rotation * Math.PI) / 180;
    if (options.rotation % 180 !== 0) {
      canvas.width = img.height;
      canvas.height = img.width;
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
  } else {
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();

  if (options.autoCrop) {
    try {
      canvas = safeCropCanvas(canvas);
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    } catch {
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  if (!ctx || canvas.width < 2 || canvas.height < 2) {
    return dataUrl;
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const contrastValue = typeof options.contrast === 'number' ? options.contrast : 1;
  const contrastFactor = (259 * (contrastValue + 255)) / (255 * (259 - contrastValue));

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i];
    let g = d[i + 1];
    let b = d[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;

    if (options.grayscale) r = g = b = gray;

    r = (r - 128) * contrastFactor + 128 + options.brightness;
    g = (g - 128) * contrastFactor + 128 + options.brightness;
    b = (b - 128) * contrastFactor + 128 + options.brightness;

    if (options.blackWhite) {
      gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = gray > options.threshold ? 255 : 0;
    }

    d[i] = clamp(r, 0, 255);
    d[i + 1] = clamp(g, 0, 255);
    d[i + 2] = clamp(b, 0, 255);
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95);
}

async function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
}

export default function App() {
  const FREE_SCAN_LIMIT = 6;
  const webcamRef = useRef(null);
  const galleryInputRef = useRef(null);
  const turboInputRef = useRef(null);

  const [isPro, setIsPro] = useState(() => localStorage.getItem(STORAGE_KEYS.isPro) === '1');
  const [documents, setDocuments] = useState(() => {
    try {
      const rawDocs = JSON.parse(localStorage.getItem(STORAGE_KEYS.documents) || 'null');
      const legacyPages = JSON.parse(localStorage.getItem(STORAGE_KEYS.legacyPages) || 'null');
      return normalizeDocuments(rawDocs, legacyPages);
    } catch {
      return [];
    }
  });
  const [currentView, setCurrentView] = useState('list');
  const [currentDocId, setCurrentDocId] = useState(() => {
    try {
      const rawDocs = JSON.parse(localStorage.getItem(STORAGE_KEYS.documents) || 'null');
      return rawDocs?.[0]?.id || null;
    } catch {
      return null;
    }
  });
  const [activePageId, setActivePageId] = useState(null);
  const [processing, setProcessing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [cameraMode, setCameraMode] = useState(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [settings, setSettings] = useState(() => {
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}')) };
    } catch {
      return DEFAULT_SETTINGS;
    }
  });
  const [filter, setFilter] = useState(DEFAULT_FILTER);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.documents, JSON.stringify(documents));
    localStorage.removeItem(STORAGE_KEYS.legacyPages);
  }, [documents]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.isPro, isPro ? '1' : '0'); }, [isPro]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings)); }, [settings]);

  useEffect(() => {
    if (!documents.length) {
      setCurrentDocId(null);
      setActivePageId(null);
      return;
    }
    if (!currentDocId || !documents.some((doc) => doc.id === currentDocId)) {
      setCurrentDocId(documents[0].id);
    }
  }, [documents, currentDocId]);

  const currentDoc = useMemo(() => documents.find((doc) => doc.id === currentDocId) || null, [documents, currentDocId]);
  const activePage = useMemo(() => currentDoc?.pages.find((p) => p.id === activePageId) || currentDoc?.pages[0] || null, [currentDoc, activePageId]);
  const totalPages = documents.reduce((sum, doc) => sum + doc.pages.length, 0);
  const remaining = Math.max(0, FREE_SCAN_LIMIT - totalPages);

  useEffect(() => {
    if (currentDoc) {
      setRenameValue(currentDoc.name);
      if (!currentDoc.pages.some((p) => p.id === activePageId)) {
        setActivePageId(currentDoc.pages[0]?.id || null);
      }
    }
  }, [currentDoc, activePageId]);

  function ensureWritable() {
    if (!isPro && totalPages >= FREE_SCAN_LIMIT) {
      alert('Demo versiyada 6 ta sahifagacha ishlaydi. Ko‘proq sahifa uchun Pro rejimga o‘ting.');
      return false;
    }
    return true;
  }

  async function appendPagesToDoc(filesData, source = 'upload', turbo = false) {
    if (!filesData.length || !ensureWritable()) return;
    setProcessing(true);
    try {
      const targetDocId = currentView === 'viewer' && currentDocId ? currentDocId : null;
      const processedPages = [];
      const localFilter = turbo ? { ...DEFAULT_FILTER, blackWhite: true, grayscale: false, brightness: 14, contrast: 90, threshold: 158, autoCrop: true } : filter;

      for (const dataUrl of filesData) {
        const scanned = await processImage(dataUrl, localFilter);
        processedPages.push({
          id: crypto.randomUUID(),
          original: dataUrl,
          scanned,
          source,
          createdAt: new Date().toISOString(),
        });
      }

      setDocuments((prev) => {
        const next = [...prev];
        let docIndex = targetDocId ? next.findIndex((doc) => doc.id === targetDocId) : -1;
        if (docIndex === -1) {
          const doc = createDocument(settings.fileNameByDate ? new Date().toISOString().slice(0, 16).replace('T', ' ') : 'Document');
          doc.pages = processedPages;
          doc.updatedAt = new Date().toISOString();
          next.unshift(doc);
          setCurrentDocId(doc.id);
          setCurrentView('viewer');
          setActivePageId(processedPages[0]?.id || null);
        } else {
          const updated = {
            ...next[docIndex],
            pages: [...next[docIndex].pages, ...processedPages],
            updatedAt: new Date().toISOString(),
          };
          next[docIndex] = updated;
          setCurrentDocId(updated.id);
          setCurrentView('viewer');
          setActivePageId(processedPages[processedPages.length - 1]?.id || updated.pages[0]?.id || null);
        }
        return next;
      });
    } finally {
      setProcessing(false);
      setCameraMode(null);
    }
  }

  async function capture() {
    const shot = webcamRef.current?.getScreenshot();
    if (shot) {
      await appendPagesToDoc([shot], 'camera', cameraMode === 'turbo');
    }
  }

  async function onUploadFiles(fileList, turbo = false) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const dataUrls = [];
    for (const file of files) {
      const reader = new FileReader();
      await new Promise((resolve) => {
        reader.onload = () => {
          dataUrls.push(String(reader.result));
          resolve();
        };
        reader.readAsDataURL(file);
      });
    }
    await appendPagesToDoc(dataUrls, 'upload', turbo);
  }

  async function reprocessActive() {
    if (!activePage || !currentDoc) return;
    setProcessing(true);
    try {
      const scanned = await processImage(activePage.original, filter);
      setDocuments((prev) => prev.map((doc) => (
        doc.id === currentDoc.id
          ? { ...doc, updatedAt: new Date().toISOString(), pages: doc.pages.map((p) => p.id === activePage.id ? { ...p, scanned } : p) }
          : doc
      )));
    } finally {
      setProcessing(false);
    }
  }

  function openDocument(docId) {
    setCurrentDocId(docId);
    setCurrentView('viewer');
    setShowShareMenu(false);
  }

  function deleteCurrentPage() {
    if (!currentDoc || !activePage) return;
    const confirmDelete = window.confirm('Tanlangan sahifa o‘chirilsinmi?');
    if (!confirmDelete) return;

    setDocuments((prev) => {
      const updatedDocs = prev
        .map((doc) => doc.id === currentDoc.id ? { ...doc, pages: doc.pages.filter((p) => p.id !== activePage.id), updatedAt: new Date().toISOString() } : doc)
        .filter((doc) => doc.pages.length > 0);
      return updatedDocs;
    });
  }

  function deleteDocument(docId) {
    const confirmDelete = window.confirm('Butun hujjat o‘chirilsinmi?');
    if (!confirmDelete) return;
    setDocuments((prev) => prev.filter((doc) => doc.id !== docId));
    if (currentDocId === docId) {
      setCurrentView('list');
      setCurrentDocId(null);
      setActivePageId(null);
      setOcrText('');
    }
  }

  function movePage(direction) {
    if (!currentDoc || !activePage) return;
    const idx = currentDoc.pages.findIndex((p) => p.id === activePage.id);
    const newIndex = idx + direction;
    if (idx < 0 || newIndex < 0 || newIndex >= currentDoc.pages.length) return;

    setDocuments((prev) => prev.map((doc) => {
      if (doc.id !== currentDoc.id) return doc;
      const pages = [...doc.pages];
      const [item] = pages.splice(idx, 1);
      pages.splice(newIndex, 0, item);
      return { ...doc, pages, updatedAt: new Date().toISOString() };
    }));
  }

  function renameCurrentDoc() {
    if (!currentDoc) return;
    const nextName = renameValue.trim() || 'Document';
    setDocuments((prev) => prev.map((doc) => doc.id === currentDoc.id ? { ...doc, name: nextName, updatedAt: new Date().toISOString() } : doc));
  }

  async function exportPdf(doc = currentDoc) {
    if (!doc?.pages?.length) return;
    const pdf = new jsPDF({ unit: 'pt', format: settings.pdfSize === 'A4' ? 'a4' : 'letter' });
    for (let i = 0; i < doc.pages.length; i++) {
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

  async function exportJpeg(page = activePage) {
    if (!page) return;
    await downloadDataUrl(page.scanned, `${currentDoc?.name || 'Document'}.jpg`);
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
      setOcrText('OCR ishlamadi. Bu rasm uchun keyinroq qayta urinib ko‘ring.');
    } finally {
      setOcrLoading(false);
    }
  }

  const docCards = [...documents].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          {currentView === 'viewer' ? (
            <button className="icon-btn" onClick={() => setCurrentView('list')} aria-label="Orqaga">←</button>
          ) : (
            <div className="app-logo">📠</div>
          )}
          <div>
            <div className="topbar-title">{currentView === 'viewer' ? (currentDoc?.name || 'Document') : 'ScanProUz'}</div>
            <div className="topbar-subtitle">
              {currentView === 'viewer' ? `${currentDoc?.pages.length || 0} str. — ${currentDoc ? formatUzDate(currentDoc.updatedAt) : ''}` : 'TurboScan uslubidagi kuchaytirilgan versiya'}
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          {currentView === 'viewer' ? (
            <>
              <button className="icon-btn" onClick={() => setShowFilters((v) => !v)} aria-label="Filter">✎</button>
              <button className="icon-btn" onClick={() => setShowShareMenu((v) => !v)} aria-label="Share">⋮</button>
            </>
          ) : (
            <>
              <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Sozlamalar">⋮</button>
            </>
          )}
        </div>
      </header>

      {currentView === 'list' ? (
        <main className="doc-list-screen">
          <div className="status-row">
            <span className="pill">{isPro ? 'Pro' : 'Demo'}</span>
            <span className="pill muted-pill">{isPro ? 'Cheksiz sahifa' : `${remaining} ta bepul sahifa qoldi`}</span>
            {!isPro && <button className="small-action" onClick={() => setIsPro(true)}>Pro demo</button>}
          </div>

          <div className="doc-list">
            {docCards.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">📄</div>
                <div className="empty-title">Hali hujjatlar yo‘q</div>
                <div className="empty-text">Pastdagi tugmalar orqali kamera ёки галереядан биринчи ҳужжатни қўшинг.</div>
              </div>
            )}
            {docCards.map((doc) => (
              <div key={doc.id} className="doc-row" onClick={() => openDocument(doc.id)}>
                <img className="doc-thumb" src={doc.pages[0]?.scanned} alt={doc.name} />
                <div className="doc-meta">
                  <div className="doc-name-row">
                    <div className="doc-name">{doc.name}</div>
                    {doc.pages.length > 1 && <span className="page-badge">{doc.pages.length}</span>}
                  </div>
                  <div className="doc-date">{formatUzDate(doc.updatedAt)}</div>
                </div>
                <button
                  className="mail-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setCurrentDocId(doc.id);
                    exportPdf(doc);
                  }}
                  title="PDF"
                >✉</button>
              </div>
            ))}
          </div>

          <div className="floating-actions">
            <button className="fab main" onClick={() => setCameraMode('camera')} title="Kamera">📷</button>
            <button className="fab main" onClick={() => setCameraMode('turbo')} title="Turbo">3x</button>
            <button className="fab main" onClick={() => galleryInputRef.current?.click()} title="Galereya">🖼️</button>
          </div>
        </main>
      ) : (
        <main className="viewer-screen">
          {showShareMenu && (
            <div className="menu-card">
              <button className="menu-item" onClick={() => { exportPdf(); setShowShareMenu(false); }}>PDF qilib yuklash</button>
              <button className="menu-item" onClick={() => { exportJpeg(); setShowShareMenu(false); }}>JPEG qilib yuklash</button>
              <button className="menu-item" onClick={() => { runOCR(); setShowShareMenu(false); }}>OCR matn olish</button>
              <button className="menu-item danger" onClick={() => { deleteDocument(currentDoc.id); setShowShareMenu(false); }}>Hujjatni o‘chirish</button>
            </div>
          )}

          {showFilters && (
            <section className="panel-card">
              <div className="panel-header">
                <strong>Tahrirlash</strong>
                <button className="small-action" onClick={reprocessActive} disabled={!activePage || processing}>{processing ? 'Qayta ishlanmoqda...' : 'Qayta ishlash'}</button>
              </div>
              <div className="rename-row">
                <input className="text-input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                <button className="small-action" onClick={renameCurrentDoc}>Saqlash</button>
              </div>
              <div className="toggle-grid">
                <label><input type="checkbox" checked={filter.blackWhite} onChange={(e) => setFilter((s) => ({ ...s, blackWhite: e.target.checked }))} /> Oq-qora</label>
                <label><input type="checkbox" checked={filter.grayscale} onChange={(e) => setFilter((s) => ({ ...s, grayscale: e.target.checked }))} /> Kulrang</label>
                <label><input type="checkbox" checked={filter.autoCrop} onChange={(e) => setFilter((s) => ({ ...s, autoCrop: e.target.checked }))} /> Xavfsiz auto crop</label>
              </div>
              <label className="range-wrap">Brightness: {filter.brightness}<input type="range" min="-80" max="80" value={filter.brightness} onChange={(e) => setFilter((s) => ({ ...s, brightness: Number(e.target.value) }))} /></label>
              <label className="range-wrap">Contrast: {filter.contrast}<input type="range" min="-100" max="150" value={filter.contrast} onChange={(e) => setFilter((s) => ({ ...s, contrast: Number(e.target.value) }))} /></label>
              <label className="range-wrap">Threshold: {filter.threshold}<input type="range" min="0" max="255" value={filter.threshold} onChange={(e) => setFilter((s) => ({ ...s, threshold: Number(e.target.value) }))} /></label>
              <button className="small-action" onClick={() => setFilter((s) => ({ ...s, rotation: (s.rotation + 90) % 360 }))}>90° aylantirish</button>
            </section>
          )}

          <section className="pages-list-card">
            {currentDoc?.pages.map((page, index) => (
              <div key={page.id} className={`page-row ${activePage?.id === page.id ? 'active' : ''}`} onClick={() => setActivePageId(page.id)}>
                <div className="page-number">{index + 1}.</div>
                <img className="page-thumb" src={page.scanned} alt={`Page ${index + 1}`} />
                <div className="reorder-handle">☰</div>
              </div>
            ))}
          </section>

          <section className="preview-card">
            {activePage ? <img className="big-preview" src={activePage.scanned} alt="preview" /> : <div className="empty-text">Sahifa topilmadi</div>}
          </section>

          <div className="file-size-note">{activePage ? `${Math.round((activePage.scanned.length * 0.75) / 1024 / 1024 * 100) / 100} mb` : ''}</div>

          <div className="floating-side-add">
            <button className="fab side" onClick={() => galleryInputRef.current?.click()}>＋</button>
          </div>

          <footer className="bottom-toolbar">
            <button className="toolbar-btn" onClick={() => exportPdf()} title="Share">⇪</button>
            <button className="toolbar-btn" onClick={() => movePage(-1)} title="Yuqoriga">⌃</button>
            <button className="toolbar-btn" onClick={() => setShowFilters((v) => !v)} title="Edit">✎</button>
            <button className="toolbar-btn" onClick={() => movePage(1)} title="Pastga">⌄</button>
            <button className="toolbar-btn danger" onClick={deleteCurrentPage} title="Delete">🗑</button>
          </footer>

          {ocrLoading || ocrText ? (
            <section className="ocr-card">
              <div className="ocr-title">OCR natija {ocrLoading ? `${ocrProgress}%` : ''}</div>
              <textarea readOnly value={ocrLoading ? 'Matn aniqlanmoqda...' : ocrText} />
            </section>
          ) : null}
        </main>
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Sozlamalar</div>
            <label className="setting-row"><span>PDF o‘lchami</span><select value={settings.pdfSize} onChange={(e) => setSettings((s) => ({ ...s, pdfSize: e.target.value }))}><option value="A4">A4</option><option value="Letter">Letter</option></select></label>
            <label className="setting-row"><span>Sana bilan nomlash</span><input type="checkbox" checked={settings.fileNameByDate} onChange={(e) => setSettings((s) => ({ ...s, fileNameByDate: e.target.checked }))} /></label>
            <label className="setting-row"><span>Avto rang</span><input type="checkbox" checked={settings.autoColor} onChange={(e) => setSettings((s) => ({ ...s, autoColor: e.target.checked }))} /></label>
            <label className="setting-row"><span>Auto page size</span><input type="checkbox" checked={settings.autoPageSize} onChange={(e) => setSettings((s) => ({ ...s, autoPageSize: e.target.checked }))} /></label>
            <button className="small-action" onClick={() => setShowSettings(false)}>Yopish</button>
          </div>
        </div>
      )}

      {cameraMode && (
        <div className="modal-backdrop" onClick={() => !processing && setCameraMode(null)}>
          <div className="camera-modal" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <strong>{cameraMode === 'turbo' ? 'Turbo scan' : 'Kamera orqali scan'}</strong>
              <button className="small-action" onClick={() => setCameraMode(null)}>Yopish</button>
            </div>
            <Webcam
              ref={webcamRef}
              audio={false}
              screenshotFormat="image/jpeg"
              videoConstraints={{ facingMode: 'environment' }}
              onUserMedia={() => setCameraReady(true)}
              className="camera-preview"
            />
            <div className="camera-hint">Ҳужжатни кадрга тўғри олиб келинг. Auto crop endi xavfsizroq ishlaydi.</div>
            <div className="camera-actions">
              <button className="small-action" disabled={!cameraReady || processing} onClick={capture}>{processing ? 'Ishlanmoqda...' : 'Suratga olish'}</button>
            </div>
          </div>
        </div>
      )}

      <input ref={galleryInputRef} className="hidden-input" type="file" accept="image/*" multiple onChange={(e) => { onUploadFiles(e.target.files, false); e.target.value = ''; }} />
      <input ref={turboInputRef} className="hidden-input" type="file" accept="image/*" multiple onChange={(e) => { onUploadFiles(e.target.files, true); e.target.value = ''; }} />
    </div>
  );
}

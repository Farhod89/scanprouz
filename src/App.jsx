import React, { useEffect, useMemo, useRef, useState } from 'react';
import Webcam from 'react-webcam';
import { jsPDF } from 'jspdf';
import Tesseract from 'tesseract.js';

const STORAGE_KEYS = {
  pages: 'scanprouz_pages',
  docName: 'scanprouz_doc_name',
  isPro: 'scanprouz_is_pro',
  activeId: 'scanprouz_active_id',
};

function dataURLToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function processImage(dataUrl, options) {
  const img = await dataURLToImage(dataUrl);
  let canvas = document.createElement('canvas');
  let ctx = canvas.getContext('2d');
  canvas.width = img.width;
  canvas.height = img.height;

  ctx.save();
  if (options.rotation !== 0) {
    const rad = (options.rotation * Math.PI) / 180;
    if (options.rotation % 180 !== 0) {
      canvas.width = img.height;
      canvas.height = img.width;
    }
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
  } else {
    ctx.drawImage(img, 0, 0);
  }
  ctx.restore();

  if (options.autoCrop) {
    const previewW = Math.min(320, canvas.width);
    const previewH = Math.round((canvas.height / canvas.width) * previewW);
    const preview = document.createElement('canvas');
    const pctx = preview.getContext('2d');
    preview.width = previewW;
    preview.height = previewH;
    pctx.drawImage(canvas, 0, 0, previewW, previewH);
    const pixels = pctx.getImageData(0, 0, previewW, previewH).data;

    let pts = [];
    for (let y = 0; y < previewH; y++) {
      for (let x = 0; x < previewW; x++) {
        const i = (y * previewW + x) * 4;
        const gray = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
        if (gray > 180) pts.push({ x, y });
      }
    }

    if (pts.length > 100) {
      let minX = previewW, minY = previewH, maxX = 0, maxY = 0;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const sx = Math.max(0, Math.round((minX / previewW) * canvas.width));
      const sy = Math.max(0, Math.round((minY / previewH) * canvas.height));
      const sw = Math.max(1, Math.round(((maxX - minX) / previewW) * canvas.width));
      const sh = Math.max(1, Math.round(((maxY - minY) / previewH) * canvas.height));
      const cropped = document.createElement('canvas');
      const cctx = cropped.getContext('2d');
      cropped.width = sw;
      cropped.height = sh;
      cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      canvas = cropped;
      ctx = cctx;
    }
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imageData.data;
  const contrastFactor = (259 * (options.contrast + 255)) / (255 * (259 - (options.contrast || 1)));

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;
    if (options.grayscale) r = g = b = gray;
    r = (r - 128) * contrastFactor + 128 + options.brightness;
    g = (g - 128) * contrastFactor + 128 + options.brightness;
    b = (b - 128) * contrastFactor + 128 + options.brightness;
    if (options.blackWhite) {
      gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = gray > options.threshold ? 255 : 0;
    }
    d[i] = Math.max(0, Math.min(255, r));
    d[i + 1] = Math.max(0, Math.min(255, g));
    d[i + 2] = Math.max(0, Math.min(255, b));
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95);
}

export default function App() {
  const FREE_SCAN_LIMIT = 3;
  const webcamRef = useRef(null);
  const [isPro, setIsPro] = useState(() => localStorage.getItem(STORAGE_KEYS.isPro) === '1');
  const [pages, setPages] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.pages);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [activeId, setActiveId] = useState(() => localStorage.getItem(STORAGE_KEYS.activeId) || null);
  const [docName, setDocName] = useState(() => localStorage.getItem(STORAGE_KEYS.docName) || 'ScanProUz-hujjat');
  const [processing, setProcessing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [showCamera, setShowCamera] = useState(true);
  const [filter, setFilter] = useState({
    grayscale: false,
    blackWhite: true,
    threshold: 160,
    brightness: 8,
    contrast: 60,
    rotation: 0,
    autoCrop: true,
  });

  const activePage = useMemo(() => pages.find((p) => p.id === activeId) || null, [pages, activeId]);
  const remaining = Math.max(0, FREE_SCAN_LIMIT - pages.length);

  useEffect(() => { localStorage.setItem(STORAGE_KEYS.pages, JSON.stringify(pages)); }, [pages]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.docName, docName); }, [docName]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.isPro, isPro ? '1' : '0'); }, [isPro]);
  useEffect(() => {
    if (activeId) localStorage.setItem(STORAGE_KEYS.activeId, activeId);
    else localStorage.removeItem(STORAGE_KEYS.activeId);
  }, [activeId]);

  async function addPage(dataUrl, source = 'camera') {
    if (!isPro && pages.length >= FREE_SCAN_LIMIT) {
      alert('Demo versiyada faqat 3 ta scan bor. Davom etish uchun Pro ga o‘ting.');
      return;
    }
    setProcessing(true);
    try {
      const scanned = await processImage(dataUrl, filter);
      const page = { id: crypto.randomUUID(), original: dataUrl, scanned, source, createdAt: new Date().toISOString() };
      setPages((prev) => [...prev, page]);
      setActiveId(page.id);
    } finally {
      setProcessing(false);
    }
  }

  async function capture() {
    const shot = webcamRef.current?.getScreenshot();
    if (shot) await addPage(shot, 'camera');
  }

  async function onUpload(e) {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      const reader = new FileReader();
      await new Promise((resolve) => {
        reader.onload = async () => { await addPage(String(reader.result), 'upload'); resolve(); };
        reader.readAsDataURL(file);
      });
    }
    e.target.value = '';
  }

  async function reprocessActive() {
    if (!activePage) return;
    setProcessing(true);
    try {
      const scanned = await processImage(activePage.original, filter);
      setPages((prev) => prev.map((p) => p.id === activePage.id ? { ...p, scanned } : p));
    } finally {
      setProcessing(false);
    }
  }

  function removePage(id) {
    setPages((prev) => {
      const next = prev.filter((p) => p.id !== id);
      if (activeId === id) setActiveId(next[0]?.id || null);
      return next;
    });
  }

  function clearHistory() {
    setPages([]);
    setActiveId(null);
    setOcrText('');
    localStorage.removeItem(STORAGE_KEYS.pages);
    localStorage.removeItem(STORAGE_KEYS.activeId);
  }

  async function exportPdf() {
    if (!pages.length) return;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    for (let i = 0; i < pages.length; i++) {
      const img = await dataURLToImage(pages[i].scanned);
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const ratio = Math.min(pageWidth / img.width, pageHeight / img.height);
      const w = img.width * ratio;
      const h = img.height * ratio;
      const x = (pageWidth - w) / 2;
      const y = (pageHeight - h) / 2;
      if (i > 0) pdf.addPage();
      pdf.addImage(pages[i].scanned, 'JPEG', x, y, w, h);
    }
    pdf.save(`${docName || 'ScanProUz-hujjat'}.pdf`);
  }

  async function runOCR() {
    if (!activePage) return;
    setOcrLoading(true);
    setOcrProgress(0);
    setOcrText('');
    try {
      const result = await Tesseract.recognize(activePage.scanned, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text' && typeof m.progress === 'number') {
            setOcrProgress(Math.round(m.progress * 100));
          }
        },
      });
      setOcrText(result.data.text || 'Matn topilmadi');
    } catch {
      setOcrText('OCR ishlamadi. Keyinroq qayta urinib ko‘ring.');
    } finally {
      setOcrLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="card">
        <div className="between">
          <div>
            <h1 className="title">ScanProUz</h1>
            <p className="subtitle">Vercel’ga жойлашга тайёр PWA версия. Demo/Pro, OCR, PDF export, history.</p>
          </div>
          <div className="row">
            <span className="badge">{isPro ? 'Pro' : 'Demo'}</span>
            <span className="badge">{isPro ? 'Cheksiz' : `${remaining} ta bepul scan qoldi`}</span>
            {!isPro && <button className="btn" onClick={() => setIsPro(true)}>Pro $1 (demo)</button>}
          </div>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card"><div className="small muted">Tarif</div><div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>{isPro ? 'Pro' : 'Demo'}</div></div>
        <div className="card"><div className="small muted">Jami sahifa</div><div style={{ fontSize: 24, fontWeight: 700, marginTop: 8 }}>{pages.length}</div></div>
        <div className="card"><div className="small muted">PWA</div><div style={{ fontSize: 18, fontWeight: 700, marginTop: 8 }}>Install + Offline ready</div></div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="between">
            <strong>Scan olish</strong>
            <div className="row">
              <button className={`btn ${showCamera ? '' : 'secondary'}`} onClick={() => setShowCamera(true)}>Kamera</button>
              <button className={`btn ${showCamera ? 'secondary' : ''}`} onClick={() => setShowCamera(false)}>Rasm yuklash</button>
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            {showCamera ? (
              <>
                <Webcam
                  ref={webcamRef}
                  audio={false}
                  screenshotFormat="image/jpeg"
                  videoConstraints={{ facingMode: 'environment' }}
                  onUserMedia={() => setCameraReady(true)}
                  style={{ width: '100%', borderRadius: 16, background: '#0f172a' }}
                />
                <div className="row" style={{ marginTop: 12 }}>
                  <button className="btn" disabled={!cameraReady || processing} onClick={capture}>Suratga olish</button>
                  <button className="btn secondary" disabled={!activePage || processing} onClick={reprocessActive}>Qayta ishlash</button>
                </div>
              </>
            ) : (
              <>
                <input className="input" type="file" accept="image/*" multiple onChange={onUpload} />
                <p className="muted small">Telefon галереяси ёки файлдан бир нечта расм юкласа ҳам бўлади.</p>
              </>
            )}
          </div>
        </div>

        <div className="card">
          <strong>Sozlamalar</strong>
          <div style={{ marginTop: 14 }}>
            <label><input type="checkbox" checked={filter.blackWhite} onChange={(e) => setFilter((s) => ({ ...s, blackWhite: e.target.checked }))} /> Oq-qora</label><br />
            <label><input type="checkbox" checked={filter.grayscale} onChange={(e) => setFilter((s) => ({ ...s, grayscale: e.target.checked }))} /> Kulrang</label><br />
            <label><input type="checkbox" checked={filter.autoCrop} onChange={(e) => setFilter((s) => ({ ...s, autoCrop: e.target.checked }))} /> Auto crop</label>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="small muted">Brightness: {filter.brightness}</div>
            <input className="range" type="range" min="-80" max="80" value={filter.brightness} onChange={(e) => setFilter((s) => ({ ...s, brightness: Number(e.target.value) }))} />
            <div className="small muted">Contrast: {filter.contrast}</div>
            <input className="range" type="range" min="-100" max="150" value={filter.contrast} onChange={(e) => setFilter((s) => ({ ...s, contrast: Number(e.target.value) }))} />
            <div className="small muted">Threshold: {filter.threshold}</div>
            <input className="range" type="range" min="0" max="255" value={filter.threshold} onChange={(e) => setFilter((s) => ({ ...s, threshold: Number(e.target.value) }))} />
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn secondary" onClick={() => setFilter((s) => ({ ...s, rotation: (s.rotation + 90) % 360 }))}>90° aylantirish</button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-main" style={{ marginTop: 16 }}>
        <div>
          <div className="card">
            <div className="between">
              <div>
                <strong>Ko‘rish oynasi</strong>
                <div className="small muted">Asl rasm ва скан натижа</div>
              </div>
              <div className="row">
                <input className="input" style={{ width: 220 }} value={docName} onChange={(e) => setDocName(e.target.value)} />
                <button className="btn" onClick={exportPdf} disabled={!pages.length}>PDF</button>
                {activePage && <button className="btn secondary" onClick={runOCR} disabled={ocrLoading}>{ocrLoading ? `OCR ${ocrProgress}%` : 'OCR'}</button>}
              </div>
            </div>
            <div className="grid grid-2" style={{ marginTop: 16 }}>
              <div>
                <div className="small muted" style={{ marginBottom: 8 }}>Asl rasm</div>
                {activePage ? <img className="preview-img" src={activePage.original} alt="Asl" /> : <div className="preview-box muted">Ҳали саҳифа йўқ</div>}
              </div>
              <div>
                <div className="small muted" style={{ marginBottom: 8 }}>Skan natija</div>
                {activePage ? <img className="preview-img" src={activePage.scanned} alt="Skan" /> : <div className="preview-box muted">Ҳали саҳифа йўқ</div>}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <strong>OCR natija</strong>
            <div className="small muted" style={{ marginTop: 4, marginBottom: 10 }}>Танланган саҳифадаги матн</div>
            <textarea readOnly value={ocrLoading ? `Matn aniqlanmoqda... ${ocrProgress}%` : (ocrText || 'OCR hali ishga tushirilmagan.')} />
          </div>
        </div>

        <div className="card">
          <div className="between">
            <strong>History</strong>
            <button className="btn ghost" onClick={clearHistory}>Tozalash</button>
          </div>
          <div style={{ marginTop: 12 }}>
            {pages.length === 0 && <div className="muted small">Ҳали саҳифа қўшилмаган.</div>}
            {pages.map((page, index) => (
              <div key={page.id} className={`sidebar-item ${activeId === page.id ? 'active' : ''}`} style={{ marginBottom: 10 }}>
                <div className="row">
                  <button style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer' }} onClick={() => setActiveId(page.id)}>
                    <img src={page.scanned} alt={`Page ${index + 1}`} className="thumb" />
                  </button>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>Sahifa {index + 1}</div>
                    <div className="small muted">{page.source}</div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="btn secondary" onClick={() => setActiveId(page.id)}>Ko‘rish</button>
                      <button className="btn ghost" onClick={() => removePage(page.id)}>O‘chirish</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

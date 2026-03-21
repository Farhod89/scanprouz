import React, { useEffect, useMemo, useRef, useState } from 'react';

const HANDLE_RADIUS = 14;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pointFromEvent(event, rect) {
  const touch = event.touches?.[0] || event.changedTouches?.[0];
  const clientX = touch ? touch.clientX : event.clientX;
  const clientY = touch ? touch.clientY : event.clientY;
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

export default function CropModal({ imageSrc, title = 'Qo‘lda crop', onClose, onSave }) {
  const frameRef = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [displaySize, setDisplaySize] = useState({ width: 1, height: 1, naturalWidth: 1, naturalHeight: 1 });
  const [points, setPoints] = useState([
    { x: 0.08, y: 0.08 },
    { x: 0.92, y: 0.08 },
    { x: 0.92, y: 0.92 },
    { x: 0.08, y: 0.92 },
  ]);

  useEffect(() => {
    function stopDrag() {
      setDragIndex(null);
    }
    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('touchend', stopDrag);
    return () => {
      window.removeEventListener('mouseup', stopDrag);
      window.removeEventListener('touchend', stopDrag);
    };
  }, []);

  const pixelPoints = useMemo(() => points.map((p) => ({ x: p.x * displaySize.width, y: p.y * displaySize.height })), [points, displaySize]);

  function beginDrag(index, e) {
    e.preventDefault();
    setDragIndex(index);
  }

  function handleMove(e) {
    if (dragIndex === null || !frameRef.current) return;
    e.preventDefault();
    const rect = frameRef.current.getBoundingClientRect();
    const next = pointFromEvent(e, rect);
    const normalized = {
      x: clamp(next.x / rect.width, 0.02, 0.98),
      y: clamp(next.y / rect.height, 0.02, 0.98),
    };
    setPoints((prev) => prev.map((point, idx) => (idx === dragIndex ? normalized : point)));
  }

  function resetPoints() {
    setPoints([
      { x: 0.08, y: 0.08 },
      { x: 0.92, y: 0.08 },
      { x: 0.92, y: 0.92 },
      { x: 0.08, y: 0.92 },
    ]);
  }

  function saveCrop() {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const crop = {
      left: clamp(Math.min(...xs), 0, 1),
      top: clamp(Math.min(...ys), 0, 1),
      right: clamp(Math.max(...xs), 0, 1),
      bottom: clamp(Math.max(...ys), 0, 1),
    };
    onSave(crop);
  }

  return (
    <div className="modal-backdrop crop-backdrop" onClick={onClose}>
      <div className="crop-modal" onClick={(e) => e.stopPropagation()}>
        <div className="camera-head">
          <div>
            <strong>{title}</strong>
            <div className="crop-hint">Qizil nuqtalarni tortib, hujjat chegarasini moslang.</div>
          </div>
          <button className="icon-btn dark" onClick={onClose}>✕</button>
        </div>

        <div
          ref={frameRef}
          className="crop-stage"
          onMouseMove={handleMove}
          onTouchMove={handleMove}
        >
          <img
            src={imageSrc}
            alt="crop"
            className="crop-image"
            onLoad={(e) => {
              const img = e.currentTarget;
              setDisplaySize({
                width: img.clientWidth || 1,
                height: img.clientHeight || 1,
                naturalWidth: img.naturalWidth || 1,
                naturalHeight: img.naturalHeight || 1,
              });
            }}
          />
          <svg className="crop-overlay" viewBox={`0 0 ${displaySize.width} ${displaySize.height}`} preserveAspectRatio="none">
            <polygon
              points={pixelPoints.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="rgba(59,130,246,0.15)"
              stroke="#ef4444"
              strokeWidth="3"
            />
            {pixelPoints.map((point, index) => (
              <g key={index}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={HANDLE_RADIUS}
                  fill="rgba(255,255,255,0.9)"
                  stroke="#ef4444"
                  strokeWidth="4"
                  onMouseDown={(e) => beginDrag(index, e)}
                  onTouchStart={(e) => beginDrag(index, e)}
                  style={{ cursor: 'grab' }}
                />
                <circle cx={point.x} cy={point.y} r={4} fill="#ef4444" pointerEvents="none" />
              </g>
            ))}
          </svg>
        </div>

        <div className="crop-actions">
          <button className="btn" onClick={resetPoints}>Qayta</button>
          <button className="btn primary" onClick={saveCrop}>Saqlash</button>
        </div>
      </div>
    </div>
  );
}

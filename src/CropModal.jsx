import React, { useRef, useEffect, useState } from "react";

export default function Cropper({ image, onCrop }) {
  const canvasRef = useRef(null);
  const [points, setPoints] = useState([
    { x: 50, y: 50 },
    { x: 300, y: 50 },
    { x: 300, y: 400 },
    { x: 50, y: 400 }
  ]);
  const [dragIndex, setDragIndex] = useState(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const img = new Image();
    img.src = image;
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      drawPoints(ctx);
    };
  }, [image, points]);

  const drawPoints = (ctx) => {
    ctx.fillStyle = "red";
    points.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  const handleMouseDown = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    points.forEach((p, i) => {
      if (Math.abs(p.x - x) < 15 && Math.abs(p.y - y) < 15) {
        setDragIndex(i);
      }
    });
  };

  const handleMouseMove = (e) => {
    if (dragIndex === null) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newPoints = [...points];
    newPoints[dragIndex] = { x, y };
    setPoints(newPoints);
  };

  const handleMouseUp = () => setDragIndex(null);

  const crop = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const minY = Math.min(...points.map(p => p.y));
    const maxY = Math.max(...points.map(p => p.y));

    const width = maxX - minX;
    const height = maxY - minY;

    const imageData = ctx.getImageData(minX, minY, width, height);

    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = width;
    tempCanvas.height = height;
    tempCanvas.getContext("2d").putImageData(imageData, 0, 0);

    onCrop(tempCanvas.toDataURL());
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{ width: "100%", borderRadius: "10px" }}
      />
      <button onClick={crop}>Saqlash</button>
    </div>
  );
}

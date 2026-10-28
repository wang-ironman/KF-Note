// View-only transforms; the saved original image is never changed.
export function installPhotoViewer(root) {
  const viewport = root.querySelector('[data-photo-viewport]');
  const image = viewport.querySelector('img');
  const output = root.querySelector('[data-photo-scale]');
  const points = new Map();
  let scale = 1, x = 0, y = 0, gesture = null, tap = null, lastTap = null, lastTouch = 0;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const local = point => {
    const box = viewport.getBoundingClientRect();
    return { x: point.x - box.left - box.width / 2, y: point.y - box.top - box.height / 2 };
  };
  function apply() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    const fit = Math.min(width / (image.naturalWidth || width), height / (image.naturalHeight || height));
    const maxX = Math.max(0, ((image.naturalWidth || width) * fit * scale - width) / 2);
    const maxY = Math.max(0, ((image.naturalHeight || height) * fit * scale - height) / 2);
    x = clamp(x, -maxX, maxX); y = clamp(y, -maxY, maxY);
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    output.textContent = `${Math.round(scale * 100)}%`;
    root.querySelector('[data-photo-zoom="out"]').disabled = scale <= 1;
    root.querySelector('[data-photo-zoom="in"]').disabled = scale >= 6;
    viewport.classList.toggle('zoomed', scale > 1);
  }
  function zoom(next, anchor = {x:0,y:0}) {
    const previous = scale; scale = clamp(next, 1, 6);
    x = anchor.x - (anchor.x - x) * scale / previous;
    y = anchor.y - (anchor.y - y) * scale / previous;
    apply();
  }
  function begin() {
    const p = [...points.values()];
    gesture = p.length ? { scale, x, y, start:p[0], midpoint:p.length > 1 ? local({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2}) : null, distance:p.length > 1 ? Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) : 0 } : null;
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-photo-zoom]'); if (!button) return;
    if (button.dataset.photoZoom === 'reset') {scale=1;x=0;y=0;apply();}
    else zoom(scale * (button.dataset.photoZoom === 'in' ? 1.5 : 1/1.5));
  });
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault(); viewport.setPointerCapture(event.pointerId);
    points.set(event.pointerId,{x:event.clientX,y:event.clientY});
    tap = points.size === 1 ? {x:event.clientX,y:event.clientY,at:Date.now(),type:event.pointerType} : null;
    if (points.size > 1) lastTap = null;
    begin();
  });
  viewport.addEventListener('pointermove', event => {
    if (!points.has(event.pointerId)) return;
    const point = {x:event.clientX,y:event.clientY}; points.set(event.pointerId,point);
    if (tap && Math.hypot(point.x-tap.x,point.y-tap.y)>8) tap=null;
    const p = [...points.values()];
    if (p.length > 1 && gesture.distance > 0) {
      scale = clamp(gesture.scale * Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) / gesture.distance,1,6);
      const midpoint = local({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2});
      x = midpoint.x - (gesture.midpoint.x-gesture.x)*scale/gesture.scale;
      y = midpoint.y - (gesture.midpoint.y-gesture.y)*scale/gesture.scale;
    } else if (gesture) {x=gesture.x+point.x-gesture.start.x;y=gesture.y+point.y-gesture.start.y;}
    apply();
  });
  viewport.addEventListener('pointerup', event => {
    points.delete(event.pointerId);
    if (tap?.type === 'touch' && Date.now()-tap.at < 300) {
      lastTouch=Date.now();
      if (lastTap && lastTouch-lastTap.at<300 && Math.hypot(tap.x-lastTap.x,tap.y-lastTap.y)<25) {
        zoom(scale>1?1:2,local(tap));lastTap=null;
      } else lastTap={...tap,at:lastTouch};
    }
    tap=null;begin();
  });
  viewport.addEventListener('pointercancel', event => {points.delete(event.pointerId);tap=null;lastTap=null;begin();});
  viewport.addEventListener('dblclick', event => {
    event.preventDefault(); if (Date.now()-lastTouch<500) return;
    zoom(scale>1?1:2,local({x:event.clientX,y:event.clientY}));
  });
  image.addEventListener('load',apply);
  const resize = new ResizeObserver(apply); resize.observe(viewport);
  apply();
  return () => {resize.disconnect();points.clear();};
}
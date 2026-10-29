// Copyright (C) 2018 The Android Open Source Project
// Copyright 2026 koviankevin
// SPDX-License-Identifier: Apache-2.0
// Adapted from Perfetto v48.0 ui/src/frontend/pan_and_zoom_handler.ts.
// Changed: standalone JS callbacks, requestAnimationFrame scheduling, bounds owned by caller.
export class PerfettoNavigation {
  constructor(element,{pan,zoom,editable=()=>false}){
    this.element=element;this.pan=pan;this.zoom=zoom;this.editable=editable;
    this.x=null;this.panDirection=0;this.zoomDirection=0;this.panOffset=0;this.panTarget=0;this.zoomOffset=0;this.zoomTarget=0;this.frame=0;this.started=0;
    element.addEventListener('pointermove',e=>{this.x=e.clientX-element.getBoundingClientRect().left;});
    document.addEventListener('keydown',e=>this.key(e,true));document.addEventListener('keyup',e=>this.key(e,false));
    window.addEventListener('blur',()=>{this.panDirection=0;this.zoomDirection=0;});
  }
  key(e,down){
    if(down&&(this.editable(e)||e.ctrlKey||e.metaKey||e.altKey))return;
    const pan=e.code==='KeyA'?-1:e.code==='KeyD'?1:0,zoom=e.code==='KeyW'?1:e.code==='KeyS'?-1:0;
    if(!pan&&!zoom)return;e.preventDefault();
    if(pan){if(down&&this.panDirection!==pan){this.panOffset=0;this.panTarget=pan*50;this.started=performance.now();}this.panDirection=down?pan:0;}
    if(zoom){if(down&&this.zoomDirection!==zoom){this.zoomOffset=0;this.zoomTarget=zoom*.1;this.started=performance.now();}this.zoomDirection=down?zoom:0;}
    if(!this.frame)this.frame=requestAnimationFrame(t=>this.step(t));
  }
  step(now){
    const velocity=1+(now-this.started)/50;
    const p=(this.panTarget-this.panOffset)*.4;
    if(this.panDirection)this.panTarget+=this.panDirection*Math.max(8*velocity,Math.abs(p));
    this.panOffset+=p;if(Math.abs(p)>.1)this.pan(p);
    const z=(this.zoomTarget-this.zoomOffset)*.4;
    if(this.zoomDirection)this.zoomTarget+=this.zoomDirection*Math.max(.008*velocity,Math.abs(z));
    this.zoomOffset+=z;if(Math.abs(z)>1e-6)this.zoom(this.x,z);
    this.frame=this.panDirection||this.zoomDirection||Math.abs(p)>.1||Math.abs(z)>1e-6?requestAnimationFrame(t=>this.step(t)):0;
  }
}
export function wheelZoomRatio(deltaY){const sign=deltaY<0?-1:1;return sign*Math.log2(1+Math.abs(deltaY))*(-.02);}

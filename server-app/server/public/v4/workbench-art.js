/* Original texture shaders: drifting silk, river light and a small boat.
   No account data, chart values, network requests or advertising actions. */
(function (V4) {
  'use strict';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const scenes = new Map();
  const images = new Map();
  const assets = {silk:'/v4/assets/silk-light-v1.webp',river:'/v4/assets/river-moon-v1.webp'};
  let motion = true, frame = 0, lastFrame = 0, artTime = 0, suspended = false, lastTheme = '';
  try { motion = localStorage.getItem('qc-art-motion') !== 'off'; } catch (_) {}
  const vertex = `attribute vec2 position; varying vec2 uv;
    void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
  const fragment = `precision highp float;
    varying vec2 uv; uniform sampler2D artwork;
    uniform vec2 resolution,pointer; uniform float time,kind,dark,imageAspect;
    void main(){
      vec2 p=vec2(uv.x,1.-uv.y), q=p;
      float aspect=resolution.x/resolution.y;
      // Contain the silk; cover the portrait without stretching its mountains.
      vec2 fit=kind>.5?vec2(min(1.,aspect/imageAspect),min(1.,imageAspect/aspect)):
        vec2(max(1.,aspect/imageAspect),max(1.,imageAspect/aspect));
      q=(q-.5)*fit+.5;
      if(kind<.5){
        q.x=1.+(p.x-1.)*fit.x;
        float body=sin(clamp(q.x,0.,1.)*3.14159);
        q.y+=body*(.014*sin(q.x*7.5-time*.55)+.005*sin(q.x*17.+time*.3));
        q+=pointer*vec2(.015,.024)*body;
      }else{
        float water=smoothstep(.702,.731,q.y);
        q.x+=water*(.0024*sin(q.y*170.-time*.45)+.0013*sin(q.y*320.+time*.38));
        q.y+=water*.0014*sin(q.x*23.+time*.5);
        float boat=exp(-pow((q.x-.33)/.07,2.)-pow((q.y-.746)/.025,2.));
        q.y+=boat*.003*sin(time*.55);
      }
      vec4 color=texture2D(artwork,clamp(q,0.,1.));
      if(kind<.5){color.a*=step(0.,q.x)*step(q.x,1.)*step(0.,q.y)*step(q.y,1.);color.rgb*=1.-dark*.08;}
      gl_FragColor=color;
    }`;

  function imageFor(kind) {
    if (!images.has(kind)) images.set(kind,new Promise((resolve,reject)=>{
      const image=new Image(); image.onload=()=>resolve(image); image.onerror=()=>reject(new Error('art_texture_unavailable')); image.src=assets[kind];
    }));
    return images.get(kind);
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('art_shader_unavailable'); }
    return shader;
  }
  function enabled() { return motion && !reduced.matches && !document.hidden && !suspended; }
  function canDraw(s) { return s.gl && s.ready && !s.lost && s.visible && s.parent.isConnected && s.canvas.width > 0; }
  function draw(s) {
    if (!s.gl || !s.ready || s.lost) return;
    const gl=s.gl;
    gl.viewport(0,0,s.canvas.width,s.canvas.height); gl.useProgram(s.program);
    gl.bindBuffer(gl.ARRAY_BUFFER,s.buffer);
    gl.enableVertexAttribArray(s.position); gl.vertexAttribPointer(s.position,2,gl.FLOAT,false,0,0);
    gl.uniform2f(s.resolution,s.canvas.width,s.canvas.height);
    gl.uniform1f(s.time,artTime); gl.uniform1f(s.kind,s.parent.dataset.artScene==='river'?1:0);
    gl.uniform1f(s.dark,document.documentElement.dataset.theme==='paper'?0:1);
    if(enabled()){s.pointer[0]+=(s.target[0]-s.pointer[0])*.08;s.pointer[1]+=(s.target[1]-s.pointer[1])*.08;}
    gl.uniform2f(s.pointerUniform,s.pointer[0],s.pointer[1]);gl.uniform1f(s.imageAspect,s.aspect);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,s.texture);gl.uniform1i(s.artwork,0);
    gl.drawArrays(gl.TRIANGLES,0,3); s.frames++;
  }
  function resize(s) {
    const box=s.parent.getBoundingClientRect();
    if (!box.width || !box.height) {s.visible=false;return;}
    const scale=Math.min(devicePixelRatio||1,1.25,1100/box.width,850/box.height);
    const width=Math.max(1,Math.round(box.width*scale)),height=Math.max(1,Math.round(box.height*scale));
    if (s.canvas.width!==width || s.canvas.height!==height) {s.canvas.width=width;s.canvas.height=height;draw(s);}
  }
  function stop() {if(frame)cancelAnimationFrame(frame);frame=0;lastFrame=0;}
  function tick(now) {
    frame=0;
    if (!enabled() || ![...scenes.values()].some(canDraw)) {lastFrame=0;return;}
    if (!lastFrame || now-lastFrame>=1000/24) {
      artTime+=lastFrame?Math.min((now-lastFrame)/1000,.1):0;
      lastFrame=now;for(const s of scenes.values())if(canDraw(s))draw(s);
    }
    frame=requestAnimationFrame(tick);
  }
  function schedule() {
    if (!enabled() || ![...scenes.values()].some(canDraw)) {stop();return;}
    if (!frame) frame=requestAnimationFrame(tick);
  }
  const intersection = typeof IntersectionObserver==='function' ? new IntersectionObserver(entries=>{
    for(const entry of entries){const s=scenes.get(entry.target);if(s)s.visible=entry.isIntersecting && entry.intersectionRect.width>0 && entry.intersectionRect.height>0;}
    schedule();
  }) : null;
  const sizing = typeof ResizeObserver==='function' ? new ResizeObserver(entries=>{
    for(const entry of entries){const s=scenes.get(entry.target);if(s)resize(s);}schedule();
  }) : null;
  function dispose(s, remove=true) {
    s.events.abort(); intersection?.unobserve(s.parent); sizing?.unobserve(s.parent);
    // A restored context has already invalidated its old handles; deleting them poisons the next upload.
    if(s.gl && !s.lost){s.gl.deleteTexture(s.texture);s.gl.deleteBuffer(s.buffer);s.gl.deleteProgram(s.program);if(remove)s.gl.getExtension('WEBGL_lose_context')?.loseContext();}
    scenes.delete(s.parent);if(remove)s.canvas.remove();
  }
  function create(parent) {
    const canvas=parent.querySelector('canvas') || document.createElement('canvas');
    canvas.setAttribute('aria-hidden','true');canvas.dataset.artRenderer='static';parent.appendChild(canvas);
    const box=parent.getBoundingClientRect();
    const s={parent,canvas,gl:null,program:null,buffer:null,texture:null,ready:false,pointer:[0,0],target:[0,0],visible:box.width>0 && box.bottom>0 && box.top<innerHeight,frames:0,lost:false,events:new AbortController()};
    scenes.set(parent,s);
    let gl,vs,fs,program,buffer;
    try {
      gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,antialias:false,depth:false,powerPreference:'low-power'});
      if(!gl)throw new Error('art_webgl_unavailable');
      vs=compile(gl,gl.VERTEX_SHADER,vertex);fs=compile(gl,gl.FRAGMENT_SHADER,fragment);
      program=gl.createProgram();gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('art_program_unavailable');
      buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
      Object.assign(s,{gl,program,buffer,position:gl.getAttribLocation(program,'position'),
        resolution:gl.getUniformLocation(program,'resolution'),time:gl.getUniformLocation(program,'time'),
        kind:gl.getUniformLocation(program,'kind'),dark:gl.getUniformLocation(program,'dark'),
        pointerUniform:gl.getUniformLocation(program,'pointer'),imageAspect:gl.getUniformLocation(program,'imageAspect'),artwork:gl.getUniformLocation(program,'artwork')});
      imageFor(parent.dataset.artScene).then(image=>{
        if(scenes.get(parent)!==s || !parent.isConnected || s.lost)return;
        if(Math.max(image.width,image.height)>gl.getParameter(gl.MAX_TEXTURE_SIZE))return;
        const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
        if(gl.getError()!==gl.NO_ERROR){gl.deleteTexture(texture);return;}
        s.texture=texture;s.aspect=image.width/image.height;s.ready=true;canvas.dataset.artRenderer='webgl';draw(s);schedule();
      }).catch(()=>{});
    } catch (_) {if(gl){if(buffer)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);}s.gl=null;}
    finally {if(gl){if(vs)gl.deleteShader(vs);if(fs)gl.deleteShader(fs);}}
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();s.lost=true;s.ready=false;canvas.dataset.artRenderer='static';schedule();},{signal:s.events.signal});
    canvas.addEventListener('webglcontextrestored',()=>{dispose(s,false);create(parent);schedule();},{signal:s.events.signal});
    resize(s);intersection?.observe(parent);sizing?.observe(parent);
    if(parent.dataset.artScene==='silk'){
      const region=parent.closest('.command-header');
      region?.addEventListener('pointermove',event=>{if(!enabled() || !s.visible)return;const r=region.getBoundingClientRect();s.target=[Math.max(-.5,Math.min(.5,(event.clientX-r.left)/r.width-.5)),Math.max(-.5,Math.min(.5,(event.clientY-r.top)/r.height-.5))];},{passive:true,signal:s.events.signal});
      region?.addEventListener('pointerleave',()=>{s.target=[0,0];},{passive:true,signal:s.events.signal});
    }
  }
  function controls() {
    let button=document.getElementById('artMotionToggle');
    if(!button){
      button=document.createElement('button');button.id='artMotionToggle';button.className='art-motion-toggle';button.type='button';
      document.querySelector('header.top .top-r')?.prepend(button);
      button.addEventListener('click',()=>{motion=!motion;try{localStorage.setItem('qc-art-motion',motion?'on':'off');}catch(_){}controls();schedule();});
    }
    const on=motion && !reduced.matches;
    button.textContent=on?'动效 · 开':'动效 · 停';button.setAttribute('aria-pressed',String(on));
    button.disabled=reduced.matches;button.title=reduced.matches?'已跟随系统减少动态偏好':(on?'暂停山水动效':'播放山水动效');
  }
  function sync() {
    for(const s of [...scenes.values()])if(!s.parent.isConnected)dispose(s);
    for(const parent of document.querySelectorAll('[data-art-scene]'))if(!scenes.has(parent))create(parent);
    const theme=document.documentElement.dataset.theme;
    if(theme!==lastTheme){lastTheme=theme;for(const s of scenes.values())draw(s);}
    controls();schedule();
  }
  document.addEventListener('visibilitychange',schedule);
  reduced.addEventListener('change',()=>{controls();schedule();});
  addEventListener('resize',()=>{for(const s of scenes.values())resize(s);schedule();});
  addEventListener('pagehide',()=>{suspended=true;stop();});
  addEventListener('pageshow',()=>{suspended=false;sync();});
  // Read-only render diagnostics for local verification; contains no account information.
  window.QC_ART={status:()=>({enabled:enabled(),running:!!frame,scenes:[...scenes.values()].map(s=>({kind:s.parent.dataset.artScene,renderer:s.gl&&s.ready&&!s.lost?'webgl':'static',visible:s.visible,frames:s.frames,width:s.canvas.width,height:s.canvas.height}))})};
  V4.onViewUpdate(sync);
})(window.V4);

import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { FINISH_DEFAULTS } from '../finishSettings'
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js'
import { bloomKernel } from '../lighting/bloom'
import { aerialSampling, createAerialState, shaftBlurFragment, shaftMaskFragment, shaftRadialFragment } from '../lighting/aerialPerspective'
import { createShaftTemporalState, shaftTemporalFragment } from '../lighting/shaftTemporal'

const eyeSampling = `uniform float uStereo;uniform vec2 uHalfPixel;
vec2 eyeUVSized(vec2 p,vec2 center,vec2 halfPixel){if(uStereo>.5){float lo=step(.5,center.x)*.5;p.x=clamp(p.x,lo+halfPixel.x,lo+.5-halfPixel.x);}return clamp(p,halfPixel,vec2(1.)-halfPixel);}
vec2 eyeUV(vec2 p,vec2 center){return eyeUVSized(p,center,uHalfPixel);}
`
const vertex = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}'
function shader(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: eyeSampling+fragmentShader, uniforms: {...uniforms,uStereo:{value:0},uHalfPixel:{value:new THREE.Vector2()}}, depthTest: false, depthWrite: false, toneMapped: false })
}

/** A single HDR scene render with shared depth, quarter-resolution bloom and
 * sun shafts, sky-coloured distance fog, then one output transform. Offscreen
 * water/probe passes run before this callback and are never graded twice. */
export function Finish() {
  const gl = useThree(state => state.gl)
  const mainScene = useThree(state => state.scene)
  const mainCamera = useThree(state => state.camera)
  const r = useMemo(() => {
    const type = gl.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType
    const source = { value: null as THREE.Texture | null }
    const a = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false })
    const b = new THREE.WebGLRenderTarget(1, 1, { type, depthBuffer: false })
    const aerial=createAerialState()
    const shaftMask=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false})
    const shafts=new THREE.WebGLRenderTarget(1,1,{depthBuffer:false})
    const mask=shader(shaftMaskFragment,aerial.uniforms)
    const shaftBlur=shader(shaftBlurFragment,{uImage:{value:shaftMask.texture},uStep:{value:new THREE.Vector2()}})
    const radial=shader(shaftRadialFragment,{uMask:{value:shaftMask.texture},uSunScreen:aerial.uniforms.uSunScreen,uShaftLength:{value:FINISH_DEFAULTS.shaftLength}})
    const temporalState=createShaftTemporalState()
    const historyA=new THREE.WebGLRenderTarget(1,1,{type,depthBuffer:false}),historyB=new THREE.WebGLRenderTarget(1,1,{type,depthBuffer:false})
    let historyRead=historyA,historyWrite=historyB
    const temporal=shader(shaftTemporalFragment,{...temporalState.uniforms,uCurrent:{value:shafts.texture},uHistory:{value:historyRead.texture},uInverseProjection:aerial.uniforms.uInverseProjection,uCameraWorld:aerial.uniforms.uCameraWorld})
    const frame={delta:1/60}
    const extract = shader(`varying vec2 vUv;uniform sampler2D uScene;uniform vec2 uPixel;uniform float uThreshold;uniform float uKnee;
      void main(){vec3 c=texture2D(uScene,vUv).rgb*.2;
      c+=(texture2D(uScene,eyeUV(vUv+uPixel,vUv)).rgb+texture2D(uScene,eyeUV(vUv-uPixel,vUv)).rgb+texture2D(uScene,eyeUV(vUv+vec2(uPixel.x,-uPixel.y),vUv)).rgb+texture2D(uScene,eyeUV(vUv+vec2(-uPixel.x,uPixel.y),vUv)).rgb)*.2;
      float bright=max(c.r,max(c.g,c.b));float knee=clamp((bright-uThreshold+uKnee)/max(2.*uKnee,.0001),0.,1.);float contribution=max(bright-uThreshold,knee*knee*uKnee*.5)/max(bright,.0001);
      gl_FragColor=vec4(c*contribution,1.);}`, { uScene: { value: source.value }, uPixel: { value: new THREE.Vector2() }, uThreshold: { value: FINISH_DEFAULTS.bloomThreshold },uKnee:{value:FINISH_DEFAULTS.bloomKnee} })
    const kernel=bloomKernel(FINISH_DEFAULTS.bloomRadius)
    let lastRadius=FINISH_DEFAULTS.bloomRadius
    const blur = shader(`varying vec2 vUv;uniform sampler2D uImage;uniform vec2 uStep;uniform float uWeights[13];uniform float uOffsets[13];
      void main(){vec3 c=texture2D(uImage,vUv).rgb*uWeights[0];
      for(int i=1;i<13;i++){
        vec2 offset=uStep*uOffsets[i];
        c+=(texture2D(uImage,eyeUV(vUv+offset,vUv)).rgb+texture2D(uImage,eyeUV(vUv-offset,vUv)).rgb)*uWeights[i];
      }
      gl_FragColor=vec4(c,1.);}`, { uImage: { value: a.texture }, uStep: { value: new THREE.Vector2() },uWeights:{value:kernel.weights},uOffsets:{value:kernel.offsets} })
    const output = shader(`varying vec2 vUv;uniform sampler2D uScene;uniform sampler2D uBloom;uniform vec2 uSize;uniform vec2 uBloomPixel;uniform float uEffects;uniform float uBloomStrength;uniform float uAberration;uniform float uFalloff;uniform float uExposure;uniform float uSaturation;uniform float uContrast;uniform float uTemperature;uniform float uTint;uniform float uTurquoise;uniform float uShadowLift;uniform float uGradeMix;uniform float uGamma;uniform float uVignetteStrength;uniform float uVignetteRadius;uniform float uVignetteSoftness;uniform float uGrainStrength;uniform float uGrainSize;uniform float uGrainSpeed;uniform float uTime;
      ${aerialSampling}
      uniform sampler2D uShafts;uniform float uShaftStrength;uniform vec2 uShaftPixel;
      vec3 filmic(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
      float filmGrain(vec2 cell,float frame){
        uvec3 p=uvec3(vec3(cell,mod(frame,65536.)));
        uint h=p.x*1973u+p.y*9277u+p.z*26699u+911u;
        h=(h^(h>>16u))*0x7feb352du;h=(h^(h>>15u))*0x846ca68bu;h=h^(h>>16u);
        return float(h&0x00ffffffu)/16777216.-.5;
      }
      void main(){
        vec2 localUv=vec2(mix(vUv.x,fract(vUv.x*2.),uStereo),vUv.y);vec2 radial=localUv-.5;vec2 shift=radial*pow(max(length(radial),.0001),uFalloff)*uAberration/uSize*uEffects;
        vec3 c=vec3(texture2D(uScene,eyeUV(vUv+shift,vUv)).r,texture2D(uScene,vUv).g,texture2D(uScene,eyeUV(vUv-shift,vUv)).b);
        c=aerialFog(c,vUv);
        c+=texture2D(uBloom,eyeUVSized(vUv,vUv,uBloomPixel)).rgb*uBloomStrength*uEffects;
        c+=texture2D(uShafts,eyeUVSized(vUv,vUv,uShaftPixel)).rgb*vec3(1.,.91,.72)*uShaftStrength*uEffects;
        // Turquoise midtones, warm ivory highlights, restrained saturation.
        vec3 graded=c*vec3(1.+uTemperature,1.+uTemperature*.6,1.-uTemperature)*vec3(1.+uTint*.5,1.-uTint,1.+uTint*.5);
        graded.g+=max(0.,graded.b-graded.r)*uTurquoise;
        float luma=dot(graded,vec3(.2126,.7152,.0722));graded=mix(vec3(luma),graded,uSaturation);
        graded+=vec3(.001,.004,.004)*uShadowLift*(1.-smoothstep(.02,.4,luma));
        graded=(graded-.18)*uContrast+.18;
        c=filmic(max(vec3(0.),mix(c,graded,uEffects*uGradeMix))*uExposure);
        c=pow(max(c,vec3(0.)),vec3(1./uGamma));
        float radius=length((localUv-.5)*vec2(1.25,1.))*1.4142;
        c*=1.-uVignetteStrength*smoothstep(uVignetteRadius-uVignetteSoftness,uVignetteRadius+uVignetteSoftness,radius)*uEffects;
        vec2 cell=floor(localUv*uSize/vec2(mix(1.,2.,uStereo),1.)/max(.5,uGrainSize));
        float frame=floor(uTime*uGrainSpeed);
        float noise=filmGrain(cell,frame);
        float grainMask=.28+.72*sin(clamp(dot(c,vec3(.2126,.7152,.0722)),0.,1.)*3.14159);
        c=max(vec3(0.),c+noise*uGrainStrength*grainMask*uEffects);
        gl_FragColor=vec4(c,1.);
        // Native HDR output performs the final display colour-space conversion.
      }`, { ...aerial.uniforms,uShafts:{value:shafts.texture},uShaftStrength:{value:0},uShaftPixel:{value:new THREE.Vector2()},uScene: { value: source.value }, uBloom: { value: a.texture }, uSize: { value: new THREE.Vector2() }, uBloomPixel: { value: new THREE.Vector2() }, uEffects: { value: 1 } })
    const aa = shader(FXAAShader.fragmentShader.replace('texture( tex2D, uv )','texture( tex2D, eyeUV(uv,vUv) )').replace('_SubpixelBlending = 1.0','_SubpixelBlending = 0.5'), THREE.UniformsUtils.clone(FXAAShader.uniforms))
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), extract), scene = new THREE.Scene(); scene.add(quad)
    for(const [name,value]of Object.entries({uBloomStrength:.075,uAberration:2.8,uFalloff:2,uExposure:.78,uSaturation:1.08,uContrast:1,uTemperature:.025,uTint:0,uTurquoise:.075,uShadowLift:1,uGradeMix:1,uGamma:1,uVignetteStrength:0,uVignetteRadius:.62,uVignetteSoftness:.42,uGrainStrength:0,uGrainSize:1,uGrainSpeed:18,uTime:0}))output.uniforms[name]={value}
    const inspection = { settings:{...FINISH_DEFAULTS}, enabled: true, mainDraws: 0, bloomPasses: 3, shaftPasses:0,shaftHistoryWeight:0,depthReady:false,stereo: false }
    const effect = {
      enabled: true, needsSwap: false,
      setSize(w: number, h: number) {
        // Keep both eye boundaries on texel edges, including odd quarter widths.
        a.setSize(Math.max(2,Math.ceil(w/8)*2),Math.max(1,Math.ceil(h/4))); b.setSize(a.width,a.height)
        // Even width keeps the two XR eyes separated at an exact texel boundary.
        shaftMask.setSize(Math.max(2,Math.ceil(w/8)*2),Math.max(1,Math.ceil(h/4)));shafts.setSize(shaftMask.width,shaftMask.height)
        historyA.setSize(shaftMask.width,shaftMask.height);historyB.setSize(shaftMask.width,shaftMask.height);temporalState.reset()
        mask.uniforms.uHalfPixel.value.set(.5/w,.5/h)
        radial.uniforms.uHalfPixel.value.set(.5/shaftMask.width,.5/shaftMask.height)
        shaftBlur.uniforms.uHalfPixel.value.copy(radial.uniforms.uHalfPixel.value)
        temporal.uniforms.uHalfPixel.value.copy(radial.uniforms.uHalfPixel.value)
        output.uniforms.uShaftPixel.value.copy(radial.uniforms.uHalfPixel.value)
        extract.uniforms.uPixel.value.set(1/w,1/h); output.uniforms.uSize.value.set(w,h)
        aa.uniforms.resolution.value.set(1/w,1/h)
        for(const m of [extract,output,aa])m.uniforms.uHalfPixel.value.set(.5/w,.5/h)
        blur.uniforms.uHalfPixel.value.set(.5/a.width,.5/a.height)
        output.uniforms.uBloomPixel.value.copy(blur.uniforms.uHalfPixel.value)
      },
      render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget) {
        inspection.mainDraws = renderer.info.render.calls
        const p=inspection.settings
        aerial.uniforms.uFogStart.value=p.fogStart
        aerial.uniforms.uFogDensity.value=inspection.enabled?p.fogDensity:0
        aerial.uniforms.uShaftRadius.value=p.shaftRadius
        radial.uniforms.uShaftLength.value=p.shaftLength
        inspection.depthReady=aerial.uniforms.uDepthReady.value===1
        const showShafts=inspection.enabled&&inspection.depthReady&&p.shaftStrength>0&&aerial.uniforms.uSunScreen.value.some(s=>s.z>0)
        output.uniforms.uShaftStrength.value=showShafts?p.shaftStrength:0
        inspection.shaftPasses=showShafts?5:0
        if(!showShafts){temporalState.reset();inspection.shaftHistoryWeight=0}
        if(p.bloomRadius!==lastRadius){const k=bloomKernel(p.bloomRadius);blur.uniforms.uWeights.value=k.weights;blur.uniforms.uOffsets.value=k.offsets;lastRadius=p.bloomRadius}
        extract.uniforms.uThreshold.value=p.bloomThreshold;extract.uniforms.uKnee.value=p.bloomKnee
        const values={uBloomStrength:p.bloomStrength,uAberration:p.aberration,uFalloff:p.aberrationFalloff,uExposure:p.exposure,uSaturation:p.saturation,uContrast:p.contrast,uTemperature:p.temperature,uTint:p.tint,uTurquoise:p.turquoise,uShadowLift:p.shadowLift,uGradeMix:p.gradeMix,uGamma:p.gamma,uVignetteStrength:p.vignetteStrength,uVignetteRadius:p.vignetteRadius,uVignetteSoftness:p.vignetteSoftness,uGrainStrength:p.grainStrength,uGrainSize:p.grainSize,uGrainSpeed:p.grainSpeed}
        for(const [name,value]of Object.entries(values))output.uniforms[name].value=value
        const xr = renderer.xr.enabled, test = renderer.getScissorTest(), viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4())
        const previous = renderer.getRenderTarget(), tone = renderer.toneMapping
        try {
          // The host has already rendered the mono or stereo scene into read.
          // Only fullscreen processing disables XR camera substitution temporarily.
          renderer.xr.enabled = false; renderer.setScissorTest(false); renderer.toneMapping = THREE.NoToneMapping
          extract.uniforms.uScene.value = output.uniforms.uScene.value = read.texture
          for(const m of [extract,blur,output,aa,mask,shaftBlur,radial,temporal])m.uniforms.uStereo.value=inspection.stereo?1:0
          if(showShafts){
            quad.material=mask;renderer.setRenderTarget(shaftMask);renderer.render(scene,camera)
            // Reuse the two shaft targets for a separable source-mask blur.
            quad.material=shaftBlur;shaftBlur.uniforms.uImage.value=shaftMask.texture;shaftBlur.uniforms.uStep.value.set(p.shaftBlur/shaftMask.width,0)
            renderer.setRenderTarget(shafts);renderer.render(scene,camera)
            shaftBlur.uniforms.uImage.value=shafts.texture;shaftBlur.uniforms.uStep.value.set(0,p.shaftBlur/shaftMask.height)
            renderer.setRenderTarget(shaftMask);renderer.render(scene,camera)
            quad.material=radial;renderer.setRenderTarget(shafts);renderer.render(scene,camera)
            temporalState.prepare(aerial.uniforms.uCameraWorld.value,aerial.uniforms.uInverseProjection.value,frame.delta,p.shaftSmoothing,inspection.stereo)
            inspection.shaftHistoryWeight=temporalState.uniforms.uHistoryWeight.value.x
            temporal.uniforms.uHistory.value=historyRead.texture
            quad.material=temporal;renderer.setRenderTarget(historyWrite);renderer.render(scene,camera)
            output.uniforms.uShafts.value=historyWrite.texture
            const oldRead=historyRead;historyRead=historyWrite;historyWrite=oldRead
            temporalState.commit(aerial.uniforms.uCameraWorld.value,aerial.uniforms.uInverseProjection.value,inspection.stereo)
          }
          if(inspection.enabled) {
            quad.material=extract; renderer.setRenderTarget(a); renderer.render(scene,camera)
            quad.material=blur; blur.uniforms.uImage.value=a.texture; blur.uniforms.uStep.value.set(1/a.width,0)
            renderer.setRenderTarget(b); renderer.render(scene,camera)
            blur.uniforms.uImage.value=b.texture; blur.uniforms.uStep.value.set(0,1/a.height)
            renderer.setRenderTarget(a); renderer.render(scene,camera)
          }
          output.uniforms.uEffects.value=inspection.enabled?1:0
          quad.material=output; renderer.setRenderTarget(write); renderer.render(scene,camera)
          // Reuse the host's other buffer; no third full-resolution allocation.
          aa.uniforms.tDiffuse.value=write.texture;quad.material=aa
          renderer.setRenderTarget(read);renderer.render(scene,camera)
        } finally {
          renderer.setRenderTarget(previous); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(test)
          renderer.xr.enabled=xr; renderer.toneMapping=tone
        }
      }
    }
    const camera = new THREE.Camera()
    return { a,b,extract,blur,output,aa,quad,scene,effect,inspection,aerial,shaftMask,shafts,mask,shaftBlur,radial,temporal,historyA,historyB,frame }
  }, [gl])
  useEffect(()=>{
    // Three's Scene callback receives a render target as argument four; the
    // published typings still inherit Object3D's geometry/material signature.
    type SceneCallback=(renderer:THREE.WebGLRenderer,scene:THREE.Scene,camera:THREE.Camera,target:THREE.WebGLRenderTarget|null)=>void
    const previous=mainScene.onBeforeRender as unknown as SceneCallback
    const prepare:SceneCallback=(renderer,scene,camera,target)=>{
      previous.call(mainScene,renderer,scene,camera,target)
      // Water reflections and other offscreen cameras must not replace eye matrices.
      if(camera===mainCamera||(renderer.xr.isPresenting&&camera===renderer.xr.getCamera())){
        r.inspection.stereo=camera instanceof THREE.ArrayCamera&&camera.cameras.length===2
        r.aerial.prepare(renderer,mainScene,camera,target)
      }
    }
    const callback=prepare as unknown as THREE.Scene['onBeforeRender']
    mainScene.onBeforeRender=callback
    return()=>{if(mainScene.onBeforeRender===callback)mainScene.onBeforeRender=previous as unknown as THREE.Scene['onBeforeRender'];r.aerial.dispose()}
  },[mainScene,mainCamera,r])
  useEffect(() => {
    const tone = gl.toneMapping
    gl.setEffects([r.effect]); gl.toneMapping = THREE.NoToneMapping
    return () => { gl.setEffects(null); gl.toneMapping = tone }
  },[gl,r])
  useFrame(({clock},delta) => { r.frame.delta=delta;r.inspection.stereo=gl.xr.isPresenting&&gl.xr.getCamera().cameras.length===2;r.output.uniforms.uTime.value=clock.elapsedTime },-.1)
  useEffect(() => () => { r.a.dispose(); r.b.dispose(); r.extract.dispose(); r.blur.dispose(); r.output.dispose(); r.aa.dispose(); r.quad.geometry.dispose();r.shaftMask.dispose();r.shafts.dispose();r.mask.dispose();r.shaftBlur.dispose();r.radial.dispose();r.temporal.dispose();r.historyA.dispose();r.historyB.dispose() }, [r])
  return <group name="helios-postprocessing" userData={r.inspection}/>
}

// Run from a project with three and esbuild. Optional argument: copied sample root.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {resolve, dirname} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const project=process.cwd()
const require=createRequire(resolve(project,'package.json'))
const {build}=require('esbuild')
const source=process.argv[2] ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)),'../assets/sample')
const scratch=resolve(project,'.cache/xrift-postprocessing-check')
await mkdir(scratch,{recursive:true})
// Resolve the same ESM Three.js entry as the bundled samples (not its CJS copy).
const runtime=resolve(scratch,'runtime.mjs')
await writeFile(runtime,'export * from "three"\n','utf8')
const T=await import(pathToFileURL(runtime))
async function load(relative){
  const outfile=resolve(scratch,relative.replaceAll('/','-').replace(/\.ts$/,'.mjs'))
  await build({entryPoints:[resolve(source,relative)],outfile,bundle:true,
    format:'esm',platform:'node',external:['three']})
  return import(pathToFileURL(outfile))
}

const {bloomKernel}=await load('lighting/bloom.ts')
for(const radius of [.25,1,1.4,1.8,2,3,4]){
  const {weights,offsets}=bloomKernel(radius),response=new Float64Array(25)
  response[0]=weights[0]
  for(let i=1;i<13;i++){
    const x=offsets[i],j=Math.floor(x),f=x-j
    response[j]+=weights[i]*(1-f)
    if(j+1<25)response[j+1]+=weights[i]*f
  }
  assert(Math.abs(response[0]+2*response.slice(1).reduce((a,b)=>a+b,0)-1)<1e-6)
  for(let i=1;i<25;i++)assert(response[i]<=response[i-1]+1e-7,`secondary bloom peak: ${radius}, ${i}`)
}
console.log('PASS: 7 normalized bloom kernels, no secondary impulse peaks')

const {createAerialState}=await load('lighting/aerialPerspective.ts')
const {SUN}=await load('constants.ts')
const scene=new T.Scene()
const sky=new T.Mesh(new T.SphereGeometry(450),new T.ShaderMaterial({uniforms:{
  uSky:{value:new T.Texture()},uAirlight:{value:new T.Texture()},
}}))
sky.name='daylight-atmosphere';scene.add(sky);scene.updateMatrixWorld(true)
const state=createAerialState(),target=new T.WebGLRenderTarget(1280,720)
let binds=0
const renderer={setRenderTarget:()=>binds++}
const sunWorld=new T.Vector3(...SUN).normalize().multiplyScalar(450)
function eye(x){
  const camera=new T.PerspectiveCamera(60,1280/720,.1,1000)
  camera.position.set(x,2.6,6);camera.lookAt(sunWorld);camera.updateMatrixWorld(true)
  return camera
}
const left=eye(-.032),right=eye(.032)
state.prepare(renderer,scene,left,target)
assert.equal(state.uniforms.uDepthReady.value,1)
assert.equal(state.uniforms.uAirlight.value,sky.material.uniforms.uAirlight.value)
assert.notEqual(state.uniforms.uAirlight.value,state.uniforms.uSky.value)
assert.equal(binds,1)
assert(target.depthTexture instanceof T.DepthTexture)
assert.equal(state.uniforms.uSunScreen.value[0].z,1)
state.prepare(renderer,scene,left,target)
assert.equal(binds,1,'Reuse existing depth attachment')
for(const distance of [.2,22,70,200,900]){
  const clip=new T.Vector4(0,0,-distance,1).applyMatrix4(left.projectionMatrix)
  clip.divideScalar(clip.w)
  const restored=clip.applyMatrix4(state.uniforms.uInverseProjection.value[0])
  assert(Math.abs(-restored.z/restored.w-distance)<1e-6)
}
state.prepare(renderer,scene,new T.ArrayCamera([left,right]),target)
assert(Math.abs(state.uniforms.uSunScreen.value[0].x-.25)<.01)
assert(Math.abs(state.uniforms.uSunScreen.value[1].x-.75)<.01)
assert.deepEqual(state.uniforms.uCameraWorld.value[1].elements,right.matrixWorld.elements)
left.lookAt(left.position.clone().multiplyScalar(2).sub(sunWorld));left.updateMatrixWorld(true)
state.prepare(renderer,scene,left,target)
assert.equal(state.uniforms.uSunScreen.value[0].z,0)
const hostTarget=new T.WebGLRenderTarget(640,480)
const hostDepth=new T.DepthTexture(640,480);hostTarget.depthTexture=hostDepth
state.prepare(renderer,scene,right,hostTarget)
state.dispose()
assert.equal(target.depthTexture,null)
assert.equal(hostTarget.depthTexture,hostDepth,'Never detach host-owned depth')
target.dispose();hostTarget.dispose();hostDepth.dispose()
sky.geometry.dispose();sky.material.uniforms.uSky.value.dispose()
sky.material.uniforms.uAirlight.value.dispose();sky.material.dispose()
console.log('PASS: depth reuse/ownership, distance reconstruction, stereo, sun behind camera')

const {shaftHistoryWeight,createShaftTemporalState}=await load('lighting/shaftTemporal.ts')
for(const fps of [30,60,72,90,120]){
  let brightness=0
  for(let i=0;i<fps;i++){
    const w=shaftHistoryWeight(1/fps,.3);brightness=(1-w)+brightness*w
  }
  assert(Math.abs(brightness-(1-Math.exp(-1/.3)))<1e-12)
}
assert.equal(shaftHistoryWeight(1/60,0),0)
assert.equal(shaftHistoryWeight(.5,.3),0)
const history=createShaftTemporalState(),eyes=[eye(-.032),eye(.032)]
const worlds=eyes.map(e=>e.matrixWorld.clone()),projections=eyes.map(e=>e.projectionMatrixInverse.clone())
history.prepare(worlds,projections,1/60,.3,false)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
history.commit(worlds,projections,false)
history.prepare(worlds,projections,1/60,.3,false)
assert(history.uniforms.uHistoryWeight.value.x>.9)
history.prepare(worlds,projections,1/60,.3,true)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
history.commit(worlds,projections,true)
const moving=worlds.map(m=>m.clone());moving[0].elements[12]+=.1
history.prepare(moving,projections,1/60,.3,true)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
assert(history.uniforms.uHistoryWeight.value.y>.9)
const zoom=projections.map(m=>m.clone());zoom[0].elements[0]*=.8
history.prepare(worlds,zoom,1/60,.3,true)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
const cut=worlds.map(m=>m.clone().multiply(new T.Matrix4().makeRotationY(.5)))
history.prepare(cut,projections,1/60,.3,true)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
history.reset();history.prepare(worlds,projections,1/60,.3,true)
assert.equal(history.uniforms.uHistoryWeight.value.x,0)
console.log('PASS: temporal response at 30/60/72/90/120fps, pause, first frame, movement, FOV, cut, XR switch, reset')

// A source compatibility check for the intentionally version-sensitive patch.
const fxaaPath=require.resolve('three/addons/shaders/FXAAShader.js')
const fxaa=await readFile(fxaaPath,'utf8')
assert(fxaa.includes('texture( tex2D, uv )'),'Review FXAA sampling patch for this Three.js version')
assert(fxaa.includes('_SubpixelBlending = 1.0'),'Review FXAA subpixel patch for this Three.js version')
console.log('PASS: FXAA patch anchors present; GPU compilation and XR hardware still require visual checks')

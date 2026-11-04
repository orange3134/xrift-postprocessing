import * as T from 'three'

/** Exponential response in seconds, independent of refresh rate. */
export function shaftHistoryWeight(delta:number,seconds:number){
  return seconds>0&&delta>0&&delta<.25?Math.exp(-delta/seconds):0
}

export const shaftTemporalFragment=`varying vec2 vUv;
uniform sampler2D uCurrent;uniform sampler2D uHistory;
uniform mat4 uInverseProjection[2];uniform mat4 uCameraWorld[2];
uniform mat4 uPreviousViewProjection[2];uniform vec2 uHistoryWeight;
void main(){
  float current=texture2D(uCurrent,vUv).r;
  int eye=uStereo>.5&&vUv.x>=.5?1:0;
  float weight=eye==0?uHistoryWeight.x:uHistoryWeight.y;
  if(weight<=0.){gl_FragColor=vec4(vec3(current),1.);return;}
  vec2 local=vec2(uStereo>.5?fract(vUv.x*2.):vUv.x,vUv.y);
  vec4 view=uInverseProjection[eye]*vec4(local*2.-1.,.0,1.);
  vec3 ray=mat3(uCameraWorld[eye])*normalize(view.xyz/view.w);
  // Rotation-only reprojection keeps history attached to the viewing direction.
  // Translation is handled by rejecting history as movement speed increases.
  vec4 previous=uPreviousViewProjection[eye]*vec4(ray,0.);
  vec2 uv=previous.xy/max(previous.w,.00001)*.5+.5;
  if(previous.w<=0.||any(lessThanEqual(uv,vec2(0.)))||any(greaterThanEqual(uv,vec2(1.))))weight=0.;
  if(uStereo>.5)uv.x=(uv.x+float(eye))*.5;
  float history=texture2D(uHistory,eyeUV(uv,vUv)).r;
  gl_FragColor=vec4(vec3(mix(current,history,weight)),1.);
}`

/** CPU bookkeeping for per-eye reprojection, view cuts, resizing and toggles. */
export function createShaftTemporalState(){
  const previousWorld=[new T.Matrix4(),new T.Matrix4()]
  const previousInverseProjection=[new T.Matrix4(),new T.Matrix4()]
  const uniforms={uPreviousViewProjection:{value:[new T.Matrix4(),new T.Matrix4()]},uHistoryWeight:{value:new T.Vector2()}}
  const inverseWorld=new T.Matrix4(),position=new T.Vector3(),oldPosition=new T.Vector3(),direction=new T.Vector3(),oldDirection=new T.Vector3()
  let valid=false,previousStereo=false
  return {
    uniforms,
    reset(){valid=false;uniforms.uHistoryWeight.value.set(0,0)},
    prepare(world:T.Matrix4[],inverseProjection:T.Matrix4[],delta:number,seconds:number,stereo:boolean){
      const base=valid&&stereo===previousStereo?shaftHistoryWeight(delta,seconds):0
      for(let i=0;i<2;i++){
        let weight=base
        position.setFromMatrixPosition(world[i]);oldPosition.setFromMatrixPosition(previousWorld[i])
        const speed=position.distanceTo(oldPosition)/Math.max(delta,.00001)
        weight*=1-T.MathUtils.smoothstep(speed,.02,.6)
        direction.setFromMatrixColumn(world[i],2);oldDirection.setFromMatrixColumn(previousWorld[i],2)
        // A cut, FOV change or XR-mode switch must not reuse an unrelated image.
        if(direction.dot(oldDirection)<Math.cos(.25)||inverseProjection[i].elements.some((v,j)=>Math.abs(v-previousInverseProjection[i].elements[j])>1e-4))weight=0
        uniforms.uHistoryWeight.value.setComponent(i,weight)
        uniforms.uPreviousViewProjection.value[i].copy(previousInverseProjection[i]).invert().multiply(inverseWorld.copy(previousWorld[i]).invert())
      }
    },
    commit(world:T.Matrix4[],inverseProjection:T.Matrix4[],stereo:boolean){
      for(let i=0;i<2;i++){previousWorld[i].copy(world[i]);previousInverseProjection[i].copy(inverseProjection[i])}
      previousStereo=stereo;valid=true
    },
  }
}

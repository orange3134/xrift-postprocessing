import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { SUN } from '../constants'

// Single-scattering atmosphere in kilometres, inspired by Bruneton/Hillaire.
// This static weather is baked once; neither integration loop runs per frame.
const bakeFragment = `
varying vec2 vUv; uniform vec3 uSun;uniform float uClouds;
const float PI=3.14159265359;
const float R=6371., A=6471.;
const vec3 betaR=vec3(.005802,.013558,.0331), betaO=vec3(.000650,.001881,.000085);
float hash(vec3 p){p=fract(p*.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
float noise3(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
 mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){return .57*noise3(p)+.28*noise3(p*2.03+19.1)+.15*noise3(p*4.17+7.6);}
vec3 density(vec3 p){float h=max(length(p)-R,0.);return vec3(exp(-h/8.),exp(-h/1.2),max(0.,1.-abs(h-25.)/15.));}
float exitDistance(vec3 p,vec3 d){float b=dot(p,d);return -b+sqrt(b*b-dot(p,p)+A*A);}
vec3 extinction(vec3 depth){return betaR*depth.x+vec3(.0044)*depth.y+betaO*depth.z;}
float cloud(vec3 p){
 float shape=fbm(vec3(p.x*.38,0.,p.z*.38)+vec3(4.2,2.7,1.6));
 float layer=smoothstep(1.35,1.58,p.y)*(1.-smoothstep(1.75,2.35,p.y));
 float detail=fbm(p*3.1);
 return max(0.,shape-.60-(1.-layer)*.22-(1.-detail)*.08)*16.;
}
void main(){
 float lon=(vUv.x-.5)*2.*PI, lat=(vUv.y-.5)*PI;
 vec3 view=vec3(cos(lat)*cos(lon),sin(lat),cos(lat)*sin(lon));
 vec3 d=normalize(vec3(view.x,max(view.y,.008),view.z));
 vec3 origin=vec3(0.,R+.08,0.);float distance=exitDistance(origin,d);
 vec3 optical=vec3(0.),sumR=vec3(0.),sumM=vec3(0.);
 for(int i=0;i<16;i++){
   float a=float(i)/16.,b=float(i+1)/16.;float stepLength=(b*b-a*a)*distance;
   vec3 p=origin+d*((a*a+b*b)*.5*distance),den=density(p);optical+=den*stepLength*.5;
   float lightDistance=exitDistance(p,uSun);vec3 lightDepth=vec3(0.);
   for(int j=0;j<6;j++){float la=float(j)/6.,lb=float(j+1)/6.;
     lightDepth+=density(p+uSun*((la*la+lb*lb)*.5*lightDistance))*(lb*lb-la*la)*lightDistance;}
   vec3 attenuation=exp(-extinction(optical+lightDepth));
   sumR+=attenuation*den.x*stepLength;sumM+=attenuation*den.y*stepLength;optical+=den*stepLength*.5;
 }
 float mu=dot(d,uSun),g=.76;
 float phaseR=3.*(1.+mu*mu)/(16.*PI),phaseM=(1.-g*g)/(4.*PI*pow(1.+g*g-2.*g*mu,1.5));
 vec3 sky=18.*(sumR*betaR*phaseR+sumM*.004*phaseM);
 sky+=vec3(.012,.022,.038)*(1.-exp(-optical.x*.07));
 float sunVisibility=1.;
 if(uClouds>.5&&view.y>.035){
   float start=1.35/view.y,finish=min(2.35/view.y,38.),stepLength=max(0.,finish-start)/32.;
   float trans=1.;vec3 light=vec3(0.);
   for(int i=0;i<32;i++){
     vec3 p=view*(start+(float(i)+.5)*stepLength);float den=cloud(p);
     if(den>.001){
       float shade=0.;for(int j=0;j<4;j++)shade+=cloud(p+uSun*(float(j)+.5)*.20)*.20;
       float alpha=1.-exp(-den*stepLength*4.);
       vec3 illumination=vec3(.24,.32,.43)+vec3(1.65,1.60,1.48)*exp(-shade*5.);
       light+=trans*alpha*illumination;trans*=1.-alpha;
     }
   }
   // Aerial perspective softens distant, low-angle cloud edges.
   float haze=exp(-start*.022);sky=mix(sky,sky*trans+light,haze);sunVisibility=trans;
 }
 sky=mix(vec3(.30,.43,.49),sky,smoothstep(-.09,.015,view.y));
 gl_FragColor=vec4(sky,sunVisibility);
}`

export function Atmosphere() {
  const gl = useThree(state => state.gl)
  const resources = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(2048, 1024, { type: gl.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false })
    target.texture.wrapS = THREE.RepeatWrapping
    // Separate smooth airlight from distant clouds. Fog must attenuate objects,
    // not composite the sky's cloud silhouettes over opaque geometry.
    const airlight = new THREE.WebGLRenderTarget(256,128,{type:target.texture.type,depthBuffer:false})
    airlight.texture.wrapS=THREE.RepeatWrapping
    const sun = new THREE.Vector3(...SUN).normalize()
    const bake = new THREE.ShaderMaterial({ toneMapped: false, depthTest: false, depthWrite: false,
      uniforms: { uSun: { value: sun },uClouds:{value:1} }, vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}', fragmentShader: bakeFragment })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bake)
    const scene = new THREE.Scene(); scene.add(quad)
    const material = new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false,
      uniforms: { uSky: { value: target.texture },uAirlight:{value:airlight.texture}, uSun: { value: sun } },
      vertexShader: 'varying vec3 vDirection;void main(){vDirection=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform sampler2D uSky;uniform vec3 uSun;varying vec3 vDirection;
      void main(){vec3 d=normalize(vDirection);vec2 uv=vec2(atan(d.z,d.x)/6.28318530718+.5,asin(d.y)/3.14159265359+.5);
        vec4 sky=texture2D(uSky,uv);vec3 color=sky.rgb;
        float angular=length(d-uSun);float aa=max(fwidth(angular),.0001);
        color+=vec3(24.,23.,20.)*(1.-smoothstep(.0075-aa,.0100+aa,angular))*sky.a;
        gl_FragColor=vec4(color,1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` })
    return { target,airlight, bake, quad, scene, camera: new THREE.Camera(), material, geometry: new THREE.SphereGeometry(450, 48, 24), ready: false }
  }, [gl])
  useFrame(({ gl }) => {
    if (resources.ready) return
    const rt = gl.getRenderTarget(), xr = gl.xr.enabled
    const viewport = gl.getViewport(new THREE.Vector4()), scissor = gl.getScissor(new THREE.Vector4()), test = gl.getScissorTest()
    try {
      gl.xr.enabled = false; gl.setScissorTest(false)
      resources.bake.uniforms.uClouds.value=1
      gl.setRenderTarget(resources.target); gl.render(resources.scene, resources.camera)
      resources.bake.uniforms.uClouds.value=0
      gl.setRenderTarget(resources.airlight); gl.render(resources.scene, resources.camera); resources.ready = true
    } finally {
      gl.setRenderTarget(rt); gl.setViewport(viewport); gl.setScissor(scissor); gl.setScissorTest(test); gl.xr.enabled = xr
    }
  }, -5)
  useEffect(() => () => { resources.target.dispose();resources.airlight.dispose(); resources.bake.dispose(); resources.quad.geometry.dispose(); resources.material.dispose(); resources.geometry.dispose() }, [resources])
  return <mesh name="daylight-atmosphere" geometry={resources.geometry} material={resources.material} renderOrder={-100} frustumCulled={false} dispose={null}/>
}

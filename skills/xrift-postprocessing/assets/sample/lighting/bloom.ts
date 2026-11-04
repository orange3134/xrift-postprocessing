/** Normalized discrete Gaussian. Pair adjacent texels for linear filtering;
 * increasing sigma never increases the gaps between sampled source texels. */
export function bloomKernel(radius:number){
  const sigma=Math.max(.4,Math.min(6.4,1.6*radius))
  const g=(x:number)=>Math.exp(-x*x/(2*sigma*sigma))
  const weights=new Float32Array(13),offsets=new Float32Array(13)
  weights[0]=1
  let sum=1
  for(let i=1;i<=12;i++){
    const x=i*2-1,a=g(x),b=g(x+1),w=a+b
    weights[i]=w;offsets[i]=w>0?x+b/w:x;sum+=2*w
  }
  for(let i=0;i<weights.length;i++)weights[i]/=sum
  return {weights,offsets}
}

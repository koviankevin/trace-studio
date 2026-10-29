// Timestamp precision follows zoom resolution, so microsecond windows at a
// late trace offset do not display identical rounded start/end labels.
export function formatTimestamp(us,resolutionUs=1){
  const magnitude=Math.abs(us),scale=magnitude>=1e6?1e6:magnitude>=1000?1000:1,unit=scale===1e6?'s':scale===1000?'ms':'µs',step=Number.isFinite(resolutionUs)&&resolutionUs>0?resolutionUs:1;
  const digits=Math.max(0,Math.min(9,Math.ceil(Math.log10(scale/step))));return `${(us/scale).toFixed(digits)} ${unit}`;
}
export function formatTimeWindow(start,end,origin=0){const resolution=Math.max((end-start)/10,1e-6);return `${formatTimestamp(start-origin,resolution)} — ${formatTimestamp(end-origin,resolution)}`;}

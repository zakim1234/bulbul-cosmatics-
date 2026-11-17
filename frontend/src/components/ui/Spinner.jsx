// A ring of 12 dots, deep blue fading to pale blue and shrinking as they fade,
// turning smoothly -- the pale tail trails the deep blue head.
const DOTS = [
  ['#1F4D2F', 4.2],
  ['#475467', 4.0],
  ['#2A7641', 3.85],
  ['#33914F', 3.7],
  ['#3FAC64', 3.55],
  ['#5BBF7E', 3.4],
  ['#1F4D2F', 3.25],
  ['#33914F', 3.1],
  ['#2A7641', 2.95],
  ['#5BBF7E', 2.8],
  ['#98A2B3', 2.65],
  ['#B3E6C4', 2.5],
];

export default function Spinner({ className = 'h-6 w-6' }) {
  return (
    <svg className={`dot-spinner ${className}`} viewBox="0 0 44 44" role="status" aria-label="Loading">
      {DOTS.map(([color, r], i) => {
        // The head (darkest) at 12 o'clock, the tail going anticlockwise, so
        // the clockwise turn leads with the head.
        const angle = (-i * 30 - 90) * (Math.PI / 180);
        return <circle key={i} cx={22 + 16 * Math.cos(angle)} cy={22 + 16 * Math.sin(angle)} r={r} fill={color} />;
      })}
    </svg>
  );
}

export function PageSpinner() {
  return (
    <div className="flex h-64 w-full items-center justify-center">
      <Spinner className="h-14 w-14" />
    </div>
  );
}

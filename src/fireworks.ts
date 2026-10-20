const COLORS = ['#6550d9', '#9282df', '#f2b84b', '#6cba97', '#ef7d9a', '#5fa8e8'];
const BURSTS = 6;
const PARTICLES_PER_BURST = 70;
const GRAVITY = 260; // px/s²
const DRAG = 0.985;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

let running = false;

/** Plays a short fireworks overlay. It ignores clicks and is skipped when reduced motion is preferred. */
export function launchFireworks(): void {
  if (running || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;
  running = true;
  canvas.className = 'fireworks';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.append(canvas);

  const ratio = Math.min(devicePixelRatio || 1, 2);
  const resize = () => {
    canvas.width = innerWidth * ratio;
    canvas.height = innerHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  const particles: Particle[] = [];
  const burst = () => {
    const x = innerWidth * (0.15 + Math.random() * 0.7);
    const y = innerHeight * (0.12 + Math.random() * 0.4);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const scale = Math.min(innerWidth, 900) / 900;
    for (let i = 0; i < PARTICLES_PER_BURST; i++) {
      const angle = (Math.PI * 2 * i) / PARTICLES_PER_BURST + Math.random() * 0.2;
      const speed = (120 + Math.random() * 220) * (0.6 + scale * 0.4);
      const maxLife = 1.1 + Math.random() * 0.7;
      particles.push({
        x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: maxLife, maxLife, color: Math.random() < 0.25 ? '#ffffff' : color, size: 1.6 + Math.random() * 1.6,
      });
    }
  };

  const start = performance.now();
  let launched = 0;
  let last = start;
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    while (launched < BURSTS && now - start >= launched * 260) {
      burst();
      launched += 1;
    }
    context.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.life -= dt;
      if (particle.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      particle.vx *= DRAG;
      particle.vy = particle.vy * DRAG + GRAVITY * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      context.globalAlpha = Math.min(1, (particle.life / particle.maxLife) * 1.5);
      context.fillStyle = particle.color;
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
      context.fill();
    }
    if (launched < BURSTS || particles.length) {
      requestAnimationFrame(frame);
    } else {
      removeEventListener('resize', resize);
      canvas.remove();
      running = false;
    }
  };
  requestAnimationFrame(frame);
}

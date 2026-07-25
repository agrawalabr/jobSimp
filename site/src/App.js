import './App.css';

const CHROME_STORE_URL = '#download'; // dummy until store listing exists

function Logo() {
  return (
    <span
      className="logo"
      aria-hidden="true"
      style={{ '--logo': `url(${process.env.PUBLIC_URL}/logo.png)` }}
    />
  );
}

function WidgetMock() {
  return (
    <aside className="product" aria-hidden="true">
      <div className="product-plane">
        <div className="widget-mock">
          <div className="wm-hd">
            <span className="wm-brand">JobSimp</span>
            <span className="wm-dot" />
            <span className="wm-who">you@gmail.com</span>
          </div>
          <div className="wm-bd">
            <div className="wm-role">Senior Software Engineer</div>
            <div className="wm-co">Acme · San Francisco</div>

            <div className="wm-lbl">Resume</div>
            <div className="wm-select">Primary resume · SWE</div>

            <div className="wm-score-row">
              <span className="wm-lbl tight">Match</span>
              <strong className="wm-score">84</strong>
            </div>
            <div className="wm-bar">
              <div className="wm-bar-fill" />
            </div>

            <div className="wm-lbl">Strong matches</div>
            <div className="wm-chips">
              <span>React</span>
              <span>TypeScript</span>
              <span>System design</span>
            </div>

            <div className="wm-lbl">Gaps</div>
            <div className="wm-chips miss">
              <span>Kubernetes</span>
            </div>

            <div className="wm-actions">
              <span className="wm-btn ghost">Apply</span>
              <span className="wm-btn">Tailor &amp; Apply</span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

export default function App() {
  return (
    <div className="page">
      <div className="atmosphere" aria-hidden="true">
        <div className="orb orb-a" />
        <div className="orb orb-b" />
        <div className="grain" />
      </div>

      <header className="top">
        <Logo />
      </header>

      <main className="hero">
        <section className="copy">
          <h1 className="brand-hero">JobSimp</h1>
          <p className="headline">Apply smarter on every job page.</p>
          <p className="tagline">
            Live match scores, resume-aware autofill, and outreach — from one floating widget.
          </p>
          <div className="cta">
            <a
              className="btn primary"
              href={CHROME_STORE_URL}
              onClick={(e) => e.preventDefault()}
            >
              Download for Chrome
            </a>
            <span className="cta-note">Coming soon</span>
          </div>
        </section>

        <WidgetMock />
      </main>
    </div>
  );
}

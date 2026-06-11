import { useState } from "react";
import axios from "axios";
import {
  Brain,
  ListChecks,
  CheckSquare,
  BookOpen,
  HelpCircle,
  Archive,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  RotateCcw,
  Loader2
} from "lucide-react";
import { getToken } from "./auth";

const API = import.meta.env.VITE_API_URL || "http://localhost:5000";

async function callClaude(prompt) {
  const res = await axios.post(`${API}/ai-insights`, { prompt });
  if (res.data.error) throw new Error(res.data.error);
  return res.data;
}

function Section({ icon: Icon, title, color, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="insights-section" style={{ "--accent": color }}>
      <button className="insights-section-header" onClick={() => setOpen(!open)}>
        <Icon size={16} style={{ color }} />
        <span style={{ color }}>{title}</span>
        {open ? <ChevronUp size={14} style={{ marginLeft: "auto", opacity: 0.5 }} /> : <ChevronDown size={14} style={{ marginLeft: "auto", opacity: 0.5 }} />}
      </button>
      {open && <div className="insights-section-body">{children}</div>}
    </div>
  );
}

function QuizCard({ q, idx }) {
  const [selected, setSelected] = useState(null);
  const correct = q.options.findIndex(o => o === q.answer);
  return (
    <div className="quiz-card">
      <p className="quiz-question"><span className="quiz-num">Q{idx + 1}.</span> {q.question}</p>
      <div className="quiz-options">
        {q.options.map((opt, i) => {
          let cls = "quiz-option";
          if (selected !== null) {
            if (i === correct) cls += " correct";
            else if (i === selected) cls += " wrong";
          }
          return (
            <button
              key={i}
              className={cls}
              onClick={() => selected === null && setSelected(i)}
              disabled={selected !== null}
            >
              {selected !== null && i === correct && <Check size={13} />}
              {selected !== null && i === selected && i !== correct && <X size={13} />}
              {opt}
            </button>
          );
        })}
      </div>
      {selected !== null && (
        <div className={`quiz-result ${selected === correct ? "pass" : "fail"}`}>
          {selected === correct ? "✓ Correct!" : `✗ Correct answer: ${q.answer}`}
        </div>
      )}
    </div>
  );
}

function FlashcardDeck({ cards }) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  if (!cards.length) return null;
  const card = cards[idx];
  return (
    <div className="flashcard-wrap">
      <div className={`flashcard ${flipped ? "flipped" : ""}`} onClick={() => setFlipped(!flipped)}>
        <div className="flashcard-front">
          <span className="fc-label">TERM</span>
          <p>{card.front}</p>
          <span className="fc-hint">tap to flip</span>
        </div>
        <div className="flashcard-back">
          <span className="fc-label">DEFINITION</span>
          <p>{card.back}</p>
        </div>
      </div>
      <div className="fc-controls">
        <button onClick={() => { setIdx((idx - 1 + cards.length) % cards.length); setFlipped(false); }} className="fc-btn">← Prev</button>
        <span className="fc-count">{idx + 1} / {cards.length}</span>
        <button onClick={() => { setIdx((idx + 1) % cards.length); setFlipped(false); }} className="fc-btn">Next →</button>
      </div>
    </div>
  );
}

export default function InsightsPanel({ lines, darkMode, insights, setInsights }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [vault, setVault] = useState([]);
  const [saved, setSaved] = useState(false);

  const transcriptText = lines.map(l => `[${l.source.toUpperCase()}] ${l.text}`).join("\n");

  const generate = async () => {
    if (!transcriptText.trim()) { setError("No transcript yet. Start session first."); return; }
    setLoading(true);
    setError("");
    setInsights(null);
    setSaved(false);

    try {
      const prompt = `You are an AI Meeting Intelligence engine. Analyze this meeting transcript and return ONLY valid JSON (no markdown, no preamble).

TRANSCRIPT:
${transcriptText.slice(0, 6000)}

Return this exact JSON shape:
{
  "summary": "2-3 sentence meeting summary",
  "keyPoints": ["point 1", "point 2", "point 3", "point 4", "point 5"],
  "actionItems": [
    { "task": "task description", "owner": "inferred owner or Team", "priority": "High|Medium|Low" }
  ],
  "flashcards": [
    { "front": "term or concept", "back": "definition or explanation" }
  ],
  "quiz": [
    {
      "question": "question text",
      "options": ["A", "B", "C", "D"],
      "answer": "correct option text"
    }
  ]
}

Generate 5 key points, 3-5 action items, 4-6 flashcards, 4 quiz questions. Ensure quiz options array has exactly 4 items and answer matches one option exactly.`;

      const data = await callClaude(prompt);
      setInsights(data);
    } catch (e) {
      setError("AI generation failed. Check API or transcript length.");
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const saveToVault = () => {
    if (!insights) return;
    const entry = {
      id: Date.now(),
      savedAt: new Date().toLocaleString(),
      lineCount: lines.length,
      ...insights
    };
    setVault(prev => [entry, ...prev]);
    setSaved(true);
  };

  const priorityColor = { High: "#ef4444", Medium: "#f59e0b", Low: "#22c55e" };

  return (
    <div className={`insights-root ${darkMode ? "dark" : ""}`}>
      <div className="insights-header-row">
        <div className="insights-title">
          <Brain size={20} style={{ color: "#a855f7" }} />
          <span>AI Meeting Intelligence</span>
        </div>
        <button
          className={`generate-btn ${loading ? "loading" : ""}`}
          onClick={generate}
          disabled={loading}
        >
          {loading ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
          {loading ? "Analyzing..." : "Generate AI Insights"}
        </button>
      </div>

      {error && <div className="insights-error">⚠ {error}</div>}

      {!insights && !loading && (
        <div className="insights-empty">
          <Brain size={40} style={{ opacity: 0.2, marginBottom: 12 }} />
          <p>Click <strong>Generate AI Insights</strong> after recording to unlock summary, key points, action items, flashcards, and quiz.</p>
        </div>
      )}

      {insights && (
        <div className="insights-grid">
          {/* Summary */}
          <Section icon={Brain} title="AI Summary" color="#a855f7" defaultOpen>
            <p className="summary-text">{insights.summary}</p>
          </Section>

          {/* Key Points */}
          <Section icon={ListChecks} title="Key Points" color="#3b82f6">
            <ul className="kp-list">
              {insights.keyPoints?.map((p, i) => (
                <li key={i} className="kp-item">
                  <span className="kp-dot" />
                  {p}
                </li>
              ))}
            </ul>
          </Section>

          {/* Action Items */}
          <Section icon={CheckSquare} title="Action Items" color="#22c55e">
            <div className="action-list">
              {insights.actionItems?.map((a, i) => (
                <div key={i} className="action-card">
                  <div className="action-top">
                    <span className="action-task">{a.task}</span>
                    <span className="priority-badge" style={{ background: priorityColor[a.priority] + "22", color: priorityColor[a.priority], border: `1px solid ${priorityColor[a.priority]}44` }}>
                      {a.priority}
                    </span>
                  </div>
                  <span className="action-owner">👤 {a.owner}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* Flashcards */}
          <Section icon={BookOpen} title="Flashcards" color="#f59e0b">
            <FlashcardDeck cards={insights.flashcards || []} />
          </Section>

          {/* Quiz */}
          <Section icon={HelpCircle} title="Quiz" color="#ec4899">
            <div className="quiz-list">
              {insights.quiz?.map((q, i) => (
                <QuizCard key={i} q={q} idx={i} />
              ))}
            </div>
          </Section>

          {/* Save to Vault */}
          <Section icon={Archive} title="Study Vault" color="#06b6d4">
            <div className="vault-save-row">
              <button className={`vault-btn ${saved ? "saved" : ""}`} onClick={saveToVault} disabled={saved}>
                {saved ? <><Check size={14} /> Saved to Vault</> : <><Archive size={14} /> Save Current Insights</>}
              </button>
            </div>
            {vault.length === 0 && <p className="vault-empty">No saved sessions yet.</p>}
            {vault.map(v => (
              <div key={v.id} className="vault-card">
                <div className="vault-card-header">
                  <span className="vault-date">{v.savedAt}</span>
                  <span className="vault-meta">{v.lineCount} lines</span>
                </div>
                <p className="vault-summary">{v.summary}</p>
                <details className="vault-details">
                  <summary>{v.keyPoints?.length} key points · {v.actionItems?.length} actions · {v.flashcards?.length} flashcards</summary>
                  <ul className="vault-kp">
                    {v.keyPoints?.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                </details>
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}
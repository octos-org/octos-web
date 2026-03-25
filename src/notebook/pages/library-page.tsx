import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, BookOpen, Filter, BarChart3, X,
} from "lucide-react";
import { createNotebook } from "../api/notebooks";

// ─── Types & Mock Data ──────────────────────────────────────

interface BookCard {
  id: string;
  title: string;
  author: string;
  isbn: string;
  subject: Subject;
  gradeLevel: GradeLevel;
  classification: string;
  noteCount: number;
  coverColor: string;
}

type Subject = "Science" | "Math" | "Literature" | "History";
type GradeLevel = "Elementary" | "Middle School" | "High School" | "College";
type LibraryTab = "bookshelf" | "stats";

const COVER_COLORS = ["bg-blue-600", "bg-emerald-600", "bg-amber-600", "bg-rose-600", "bg-violet-600", "bg-cyan-600", "bg-orange-600", "bg-pink-600"];

const MOCK_BOOKS: BookCard[] = [
  { id: "b1", title: "Introduction to Physics", author: "Richard Feynman", isbn: "978-0-201-02115-8", subject: "Science", gradeLevel: "College", classification: "QC21.3", noteCount: 42, coverColor: COVER_COLORS[0] },
  { id: "b2", title: "Calculus: Early Transcendentals", author: "James Stewart", isbn: "978-1-285-74155-0", subject: "Math", gradeLevel: "College", classification: "QA303.2", noteCount: 38, coverColor: COVER_COLORS[1] },
  { id: "b3", title: "To Kill a Mockingbird", author: "Harper Lee", isbn: "978-0-06-112008-4", subject: "Literature", gradeLevel: "High School", classification: "PS3562", noteCount: 25, coverColor: COVER_COLORS[2] },
  { id: "b4", title: "A People's History of the United States", author: "Howard Zinn", isbn: "978-0-06-083865-2", subject: "History", gradeLevel: "College", classification: "E178", noteCount: 31, coverColor: COVER_COLORS[3] },
  { id: "b5", title: "Biology: The Unity of Life", author: "Cecie Starr", isbn: "978-1-305-07395-1", subject: "Science", gradeLevel: "High School", classification: "QH308.2", noteCount: 19, coverColor: COVER_COLORS[4] },
  { id: "b6", title: "Linear Algebra Done Right", author: "Sheldon Axler", isbn: "978-3-319-11079-0", subject: "Math", gradeLevel: "College", classification: "QA184.2", noteCount: 15, coverColor: COVER_COLORS[5] },
  { id: "b7", title: "The Great Gatsby", author: "F. Scott Fitzgerald", isbn: "978-0-7432-7356-5", subject: "Literature", gradeLevel: "High School", classification: "PS3511", noteCount: 22, coverColor: COVER_COLORS[6] },
  { id: "b8", title: "Guns, Germs, and Steel", author: "Jared Diamond", isbn: "978-0-393-31755-8", subject: "History", gradeLevel: "College", classification: "HM206", noteCount: 28, coverColor: COVER_COLORS[7] },
  { id: "b9", title: "Chemistry: The Central Science", author: "Theodore Brown", isbn: "978-0-13-441423-2", subject: "Science", gradeLevel: "College", classification: "QD33.2", noteCount: 35, coverColor: COVER_COLORS[0] },
  { id: "b10", title: "The Odyssey", author: "Homer", isbn: "978-0-14-026886-7", subject: "Literature", gradeLevel: "Middle School", classification: "PA4025", noteCount: 12, coverColor: COVER_COLORS[3] },
  { id: "b11", title: "Pre-Algebra Essentials", author: "Mary Bettinger", isbn: "978-0-07-352529-0", subject: "Math", gradeLevel: "Elementary", classification: "QA154.3", noteCount: 8, coverColor: COVER_COLORS[1] },
  { id: "b12", title: "World History: Patterns of Interaction", author: "Roger Beck", isbn: "978-0-547-49118-0", subject: "History", gradeLevel: "Middle School", classification: "D21", noteCount: 17, coverColor: COVER_COLORS[2] },
];

const SUBJECTS: Subject[] = ["Science", "Math", "Literature", "History"];
const GRADE_LEVELS: GradeLevel[] = ["Elementary", "Middle School", "High School", "College"];

// ─── Stats Mock Data ────────────────────────────────────────

const WEEKLY_ACTIVITY = [
  { day: "Mon", count: 12 },
  { day: "Tue", count: 8 },
  { day: "Wed", count: 15 },
  { day: "Thu", count: 6 },
  { day: "Fri", count: 20 },
  { day: "Sat", count: 3 },
  { day: "Sun", count: 9 },
];

// ─── Library Page ───────────────────────────────────────────

export function LibraryPage() {
  const [tab, setTab] = useState<LibraryTab>("bookshelf");

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-text-strong">Library</h1>
          <p className="text-sm text-muted">Browse books, track usage, and create notebooks</p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setTab("bookshelf")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
              tab === "bookshelf" ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-light hover:text-text"
            }`}
          >
            <BookOpen size={16} />
            Bookshelf
          </button>
          <button
            onClick={() => setTab("stats")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
              tab === "stats" ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-light hover:text-text"
            }`}
          >
            <BarChart3 size={16} />
            Stats
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === "bookshelf" ? <BookshelfView /> : <StatsView />}
      </div>
    </div>
  );
}

// ─── Bookshelf View (Issue #45) ─────────────────────────────

function BookshelfView() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<Subject | null>(null);
  const [gradeFilter, setGradeFilter] = useState<GradeLevel | null>(null);
  const [showFilters, setShowFilters] = useState(true);

  const filtered = MOCK_BOOKS.filter((b) => {
    if (subjectFilter && b.subject !== subjectFilter) return false;
    if (gradeFilter && b.gradeLevel !== gradeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) || b.isbn.includes(q);
    }
    return true;
  });

  const handleBookClick = async (book: BookCard) => {
    const nb = await createNotebook(book.title, `Notes for "${book.title}" by ${book.author}`);
    navigate(`/notebooks/${nb.id}`);
  };

  return (
    <div className="flex h-full">
      {/* Filter sidebar */}
      {showFilters && (
        <div className="w-56 shrink-0 border-r border-border p-4 overflow-y-auto">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium text-text-strong">Filters</h3>
            <button onClick={() => setShowFilters(false)} className="text-muted hover:text-text"><X size={14} /></button>
          </div>

          {/* Subject */}
          <div className="mb-4">
            <label className="mb-2 block text-xs font-medium text-muted">Subject</label>
            <div className="space-y-1">
              {SUBJECTS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSubjectFilter(subjectFilter === s ? null : s)}
                  className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${
                    subjectFilter === s ? "bg-accent/15 text-accent" : "text-text hover:bg-surface-light"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Grade Level */}
          <div>
            <label className="mb-2 block text-xs font-medium text-muted">Grade Level</label>
            <div className="space-y-1">
              {GRADE_LEVELS.map((g) => (
                <button
                  key={g}
                  onClick={() => setGradeFilter(gradeFilter === g ? null : g)}
                  className={`block w-full rounded-lg px-3 py-1.5 text-left text-sm transition ${
                    gradeFilter === g ? "bg-accent/15 text-accent" : "text-text hover:bg-surface-light"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 overflow-y-auto">
        {/* Search bar */}
        <div className="flex items-center gap-2 px-6 py-3">
          {!showFilters && (
            <button onClick={() => setShowFilters(true)} className="rounded-lg border border-border p-2 text-muted hover:text-text">
              <Filter size={16} />
            </button>
          )}
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search by title, author, or ISBN..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface py-2 pl-10 pr-4 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </div>

        {/* Active filters */}
        {(subjectFilter || gradeFilter) && (
          <div className="flex gap-2 px-6 pb-2">
            {subjectFilter && (
              <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent">
                {subjectFilter}
                <button onClick={() => setSubjectFilter(null)}><X size={12} /></button>
              </span>
            )}
            {gradeFilter && (
              <span className="flex items-center gap-1 rounded-full bg-accent/10 px-2.5 py-1 text-xs text-accent">
                {gradeFilter}
                <button onClick={() => setGradeFilter(null)}><X size={12} /></button>
              </span>
            )}
          </div>
        )}

        {/* Book grid */}
        <div className="px-6 pb-6">
          {filtered.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center text-muted">
              <BookOpen size={48} className="mb-4 opacity-30" />
              <p className="text-lg">No books found</p>
              <p className="text-sm">Try adjusting your filters or search</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filtered.map((book) => (
                <div
                  key={book.id}
                  onClick={() => handleBookClick(book)}
                  className="group cursor-pointer rounded-xl border border-border bg-surface p-3 transition hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5"
                >
                  {/* Cover placeholder */}
                  <div className={`mb-3 flex h-36 items-center justify-center rounded-lg ${book.coverColor}`}>
                    <span className="text-4xl font-bold text-white/80">{book.title[0]}</span>
                  </div>
                  <h4 className="mb-0.5 truncate text-sm font-medium text-text-strong group-hover:text-accent transition">
                    {book.title}
                  </h4>
                  <p className="mb-1 truncate text-xs text-muted">{book.author}</p>
                  <p className="mb-1 text-xs text-muted">{book.classification}</p>
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span>{book.subject}</span>
                    <span>{book.noteCount} notes</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Stats View (Issue #48) ─────────────────────────────────

function StatsView() {
  const totalNotebooks = 24;
  const totalSources = 156;
  const totalNotes = 412;
  const totalUsers = 18;

  const popularBooks = [...MOCK_BOOKS].sort((a, b) => b.noteCount - a.noteCount).slice(0, 5);
  const maxActivity = Math.max(...WEEKLY_ACTIVITY.map((d) => d.count));

  return (
    <div className="overflow-y-auto p-6">
      <h2 className="mb-6 text-lg font-semibold text-text-strong">Usage Statistics</h2>

      {/* Summary cards */}
      <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Notebooks", value: totalNotebooks, color: "text-blue-400" },
          { label: "Sources", value: totalSources, color: "text-emerald-400" },
          { label: "Notes", value: totalNotes, color: "text-amber-400" },
          { label: "Users", value: totalUsers, color: "text-violet-400" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-xl border border-border bg-surface p-4 text-center">
            <div className={`text-2xl font-bold ${stat.color}`}>{stat.value}</div>
            <div className="text-xs text-muted">{stat.label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Activity this week */}
        <div className="rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-4 text-sm font-semibold text-text-strong">Activity This Week</h3>
          <div className="flex h-40 items-end gap-2">
            {WEEKLY_ACTIVITY.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className="w-full rounded-t bg-accent/70 transition-all"
                  style={{ height: `${(d.count / maxActivity) * 100}%` }}
                />
                <span className="text-xs text-muted">{d.day}</span>
                <span className="text-xs text-text">{d.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Popular books */}
        <div className="rounded-xl border border-border bg-surface p-4">
          <h3 className="mb-4 text-sm font-semibold text-text-strong">Popular Books</h3>
          <div className="space-y-3">
            {popularBooks.map((book, i) => (
              <div key={book.id} className="flex items-center gap-3">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-xs font-medium text-accent">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm text-text-strong">{book.title}</p>
                  <p className="text-xs text-muted">{book.author}</p>
                </div>
                <span className="text-xs text-muted">{book.noteCount} notes</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

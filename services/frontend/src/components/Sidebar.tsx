import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Session, User } from '../types';
import {
  Search,
  MessageSquare,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  Edit3,
  Clock,
  Paperclip,
  Settings,
  ShieldCheck,
  LogOut,
  Loader2,
} from 'lucide-react';
import ThemeToggle from './ThemeToggle';

function initials(name?: string | null, email?: string) {
  const source = name?.trim() || email || '';
  const parts = source.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase() || '?';
}

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 240;

interface SidebarProps {
  sessions: Session[];
  activeSession: Session | null;
  isOpen: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onSelectSession: (session: Session) => void;
  onDeleteSession: (sessionId: string) => void;
  user?: User;
  onLogout?: () => void;
  onOpenAdmin?: () => void;
  onOpenSettings?: () => void;
  /** Sessions with a generation running in the background */
  pendingSessions?: Record<string, boolean>;
  /** Sessions whose generation finished while the user was elsewhere */
  unseenSessions?: Record<string, boolean>;
}

const Sidebar = memo(function Sidebar({
  sessions,
  activeSession,
  isOpen,
  onToggle,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  user,
  onLogout,
  onOpenAdmin,
  onOpenSettings,
  pendingSessions = {},
  unseenSessions = {},
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const isDragging = useRef(false);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  function cleanSessionName(name: string): { hasAttachment: boolean; cleanName: string } {
    const match = name.match(/^\[Attached:\s*.+?\]\s*/);
    if (match) {
      const cleanName = name.slice(match[0].length).trim();
      return { hasAttachment: true, cleanName: cleanName || 'File upload' };
    }
    return { hasAttachment: false, cleanName: name };
  }

  const filteredSessions = sessions.filter(session =>
    session.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatDateTime = (date: string | Date) => {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (d.toDateString() === today.toDateString()) {
      return `Today, ${time}`;
    } else if (d.toDateString() === yesterday.toDateString()) {
      return `Yesterday, ${time}`;
    } else {
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${time}`;
    }
  };

  if (!isOpen) {
    return (
      <div className="w-12 bg-panel border-r border-hairline flex flex-col items-center py-3 gap-1">
        <button
          onClick={onToggle}
          className="p-2 rounded-lg text-muted hover:bg-elevated hover:text-ink transition-colors"
          title="Open sidebar"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        <button
          onClick={onNewChat}
          className="p-2 rounded-lg text-muted hover:bg-elevated hover:text-ink transition-colors"
          title="New chat"
        >
          <Edit3 className="w-4 h-4" />
        </button>

        {/* collapsed footer rail: theme + avatar + settings + logout */}
        <div className="mt-auto flex flex-col items-center gap-2 pt-2 border-t border-hairline w-full">
          <ThemeToggle variant="icon" />
          {user && (
            <span
              title={`${user.name || user.email} · ${user.role}`}
              className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-brass to-brass-dim font-mono text-xs font-600 text-obsidian"
            >
              {initials(user.name, user.email)}
            </span>
          )}
          {onOpenSettings && (
            <button
              onClick={onOpenSettings}
              title="Settings"
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink"
            >
              <Settings className="h-4 w-4" />
            </button>
          )}
          {onOpenAdmin && (
            <button
              onClick={onOpenAdmin}
              title="Admin portal"
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink"
            >
              <ShieldCheck className="h-4 w-4" />
            </button>
          )}
          {onLogout && (
            <button
              onClick={onLogout}
              title="Log out"
              className="rounded-md p-1.5 text-faint transition-colors hover:bg-danger/10 hover:text-danger"
            >
              <LogOut className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative bg-panel border-r border-hairline flex flex-col h-full min-h-0 flex-shrink-0 max-w-full"
      style={{ width: sidebarWidth }}
    >
      {/* Drag handle on right edge */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-brass/50 active:bg-brass transition-colors"
      />

      {/* Header */}
      <div className="p-3 flex items-center justify-between border-b border-hairline">
        <span className="eyebrow">Sessions</span>
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg text-muted hover:bg-elevated hover:text-ink transition-colors"
          title="Close sidebar"
        >
          <PanelLeftClose className="w-4 h-4" />
        </button>
      </div>

      {/* New chat button */}
      <div className="px-2 py-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-ink bg-elevated border border-hairline rounded-lg hover:bg-raised hover:border-hairline-strong transition-colors"
        >
          <Edit3 className="w-3.5 h-3.5 text-brass" />
          New chat
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint" />
          <input
            type="text"
            placeholder="Search chats"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-2 py-1.5 bg-obsidian/60 border border-hairline rounded-lg text-xs text-ink placeholder:text-faint focus:outline-none focus:border-brass/60 transition-colors"
          />
        </div>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto px-2 pt-1">
        {filteredSessions.length === 0 ? (
          <div className="text-center py-6 text-faint text-xs">
            {searchQuery ? 'No chats found' : 'No chats yet'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredSessions.map(session => {
              const { hasAttachment, cleanName } = cleanSessionName(session.name || 'New Chat');
              const isActive = activeSession?.id === session.id;
              return (
                <div
                  key={session.id}
                  className={`group relative flex flex-col px-2.5 py-2 rounded-lg cursor-pointer border transition-colors ${
                    isActive
                      ? 'bg-elevated border-hairline-strong'
                      : 'border-transparent hover:bg-elevated/60'
                  }`}
                  onClick={() => onSelectSession(session)}
                  onMouseEnter={() => setHoveredSession(session.id)}
                  onMouseLeave={() => setHoveredSession(null)}
                >
                  <div className="flex items-start gap-2 overflow-hidden">
                    {hasAttachment ? (
                      <Paperclip className="w-3.5 h-3.5 flex-shrink-0 text-brass mt-0.5" />
                    ) : (
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-faint mt-0.5" />
                    )}
                    <span
                      className={`flex-1 text-xs min-w-0 ${isActive ? 'text-ink' : 'text-muted'}`}
                      style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}
                    >
                      {cleanName}
                    </span>

                    {/* Background activity: generating / finished-unseen */}
                    {pendingSessions[session.id] ? (
                      <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin text-brass mt-0.5" />
                    ) : unseenSessions[session.id] ? (
                      <span className="w-2 h-2 flex-shrink-0 rounded-full bg-brass mt-1" title="Response ready" />
                    ) : null}

                    {/* Delete button */}
                    {hoveredSession === session.id && (
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        className="p-1 rounded text-faint hover:bg-raised hover:text-danger transition-colors"
                        title="Delete chat"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {/* Date and time */}
                  <div className="flex items-center gap-1 mt-1 pl-5">
                    <Clock className="w-2.5 h-2.5 text-faint" />
                    <span className="text-[10px] font-mono text-faint">
                      {formatDateTime(session.updatedAt || session.createdAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: theme + user + settings + logout */}
      <div className="space-y-2 border-t border-hairline p-3">
        <ThemeToggle variant="pill" />

        {user && (
          <div className="flex items-center gap-2 rounded-lg border border-hairline bg-panel px-2 py-1.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-brass to-brass-dim font-mono text-xs font-600 text-obsidian">
              {initials(user.name, user.email)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-500 text-ink">{user.name || user.email}</div>
              <div className="font-mono text-[10px] uppercase tracking-wider text-faint">
                {user.role}
              </div>
            </div>
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink"
              >
                <Settings className="h-4 w-4" />
              </button>
            )}
            {onOpenAdmin && (
              <button
                onClick={onOpenAdmin}
                title="Admin portal"
                className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-ink"
              >
                <ShieldCheck className="h-4 w-4" />
              </button>
            )}
            {onLogout && (
              <button
                onClick={onLogout}
                title="Log out"
                className="rounded-md p-1.5 text-faint transition-colors hover:bg-danger/10 hover:text-danger"
              >
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default Sidebar;

import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { Session } from '../types';
import {
  Search,
  MessageSquare,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  Edit3,
  Sparkles,
  Clock,
  Paperclip,
} from 'lucide-react';

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 224; // w-56

interface SidebarProps {
  sessions: Session[];
  activeSession: Session | null;
  isOpen: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onSelectSession: (session: Session) => void;
  onDeleteSession: (sessionId: string) => void;
}

const Sidebar = memo(function Sidebar({
  sessions,
  activeSession,
  isOpen,
  onToggle,
  onNewChat,
  onSelectSession,
  onDeleteSession,
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
      <div className="w-12 bg-gray-50 border-r border-gray-200 flex flex-col items-center py-3 gap-1">
        <button
          onClick={onToggle}
          className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
          title="Open sidebar"
        >
          <PanelLeft className="w-4 h-4 text-gray-500" />
        </button>
        <button
          onClick={onNewChat}
          className="p-2 rounded-lg hover:bg-gray-200 transition-colors"
          title="New chat"
        >
          <Edit3 className="w-4 h-4 text-gray-500" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative bg-gray-50 flex flex-col h-screen flex-shrink-0" style={{ width: sidebarWidth }}>
      {/* Drag handle on right edge */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize z-10 hover:bg-blue-400 active:bg-blue-500 transition-colors"
      />

      {/* Header with logo */}
      <div className="p-3 flex items-center justify-between border-b border-gray-100">
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-xs font-semibold text-gray-700">Circini Migration Agent</span>
        </div>
        <button
          onClick={onToggle}
          className="p-1.5 rounded-lg hover:bg-gray-200 transition-colors"
          title="Close sidebar"
        >
          <PanelLeftClose className="w-4 h-4 text-gray-500" />
        </button>
      </div>

      {/* New chat button */}
      <div className="px-2 py-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Edit3 className="w-3.5 h-3.5" />
          New chat
        </button>
      </div>

      {/* Search */}
      <div className="px-2 pb-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search chats"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-2 py-1.5 bg-white border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-gray-300 focus:border-transparent"
          />
        </div>
      </div>

      {/* Chats label */}
      <div className="px-3 py-1.5">
        <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Chats</span>
      </div>

      {/* Sessions List */}
      <div className="flex-1 overflow-y-auto px-2">
        {filteredSessions.length === 0 ? (
          <div className="text-center py-6 text-gray-400 text-xs">
            {searchQuery ? 'No chats found' : 'No chats yet'}
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredSessions.map(session => {
              const { hasAttachment, cleanName } = cleanSessionName(session.name || 'New Chat');
              return (
              <div
                key={session.id}
                className={`group relative flex flex-col px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                  activeSession?.id === session.id
                    ? 'bg-gray-200'
                    : 'hover:bg-gray-100'
                }`}
                onClick={() => onSelectSession(session)}
                onMouseEnter={() => setHoveredSession(session.id)}
                onMouseLeave={() => setHoveredSession(null)}
              >
                <div className="flex items-start gap-2 overflow-hidden">
                  {hasAttachment ? (
                    <Paperclip className="w-3.5 h-3.5 flex-shrink-0 text-blue-400 mt-0.5" />
                  ) : (
                    <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 text-gray-400 mt-0.5" />
                  )}
                  <span className="flex-1 text-xs text-gray-600 min-w-0" style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                    {cleanName}
                  </span>

                  {/* Delete button */}
                  {hoveredSession === session.id && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      className="p-1 rounded hover:bg-gray-300 text-gray-400 hover:text-red-500 transition-colors"
                      title="Delete chat"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {/* Date and time */}
                <div className="flex items-center gap-1 mt-1 ml-5.5 pl-0.5">
                  <Clock className="w-2.5 h-2.5 text-gray-400" />
                  <span className="text-[10px] text-gray-400">
                    {formatDateTime(session.updatedAt || session.createdAt)}
                  </span>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer - User section */}
      <div className="p-2 border-t border-gray-100">
        <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-100 cursor-pointer">
          <div className="w-6 h-6 rounded-full bg-gray-300 flex items-center justify-center">
            <span className="text-[10px] font-medium text-gray-600">U</span>
          </div>
          <span className="text-xs text-gray-600">User</span>
        </div>
      </div>
    </div>
  );
});

export default Sidebar;

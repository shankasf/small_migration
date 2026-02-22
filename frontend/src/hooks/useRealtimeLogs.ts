import { useEffect, useState, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

export interface LogEntry {
  timestamp: string;
  step: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error' | 'progress' | 'thinking';
  data?: any;
}

// Use current origin for WebSocket connection (works through ingress)
const getSocketUrl = () => {
  if (typeof window !== 'undefined') {
    return window.location.origin;
  }
  return 'http://localhost:3001';
};

export function useRealtimeLogs(sessionId: string | null) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const currentSessionRef = useRef<string | null>(null);

  // Clear logs
  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  // Create socket once on mount
  useEffect(() => {
    const socket = io(getSocketUrl(), {
      path: '/api/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('[WebSocket] Connected:', socket.id);
      setIsConnected(true);

      // Re-join current session's room on reconnect
      if (currentSessionRef.current) {
        socket.emit('join-session', currentSessionRef.current);
      }
    });

    socket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected');
      setIsConnected(false);
    });

    socket.on('log', (log: LogEntry) => {
      console.log('[WebSocket] Log received:', log);
      setLogs(prev => [...prev, log]);
    });

    socket.on('connect_error', (error) => {
      console.error('[WebSocket] Connection error:', error);
    });

    return () => {
      if (currentSessionRef.current) {
        socket.emit('leave-session', currentSessionRef.current);
      }
      socket.disconnect();
      socketRef.current = null;
    };
  }, []); // Empty deps — socket created once

  // Handle session changes — join/leave rooms on the existing socket
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket) return;

    // Leave old session
    if (currentSessionRef.current && currentSessionRef.current !== sessionId) {
      socket.emit('leave-session', currentSessionRef.current);
    }

    // Join new session
    if (sessionId) {
      if (socket.connected) {
        socket.emit('join-session', sessionId);
      }
      currentSessionRef.current = sessionId;
      clearLogs();
    } else {
      currentSessionRef.current = null;
    }
  }, [sessionId, clearLogs]);

  return {
    logs,
    isConnected,
    clearLogs,
  };
}

"""
Session Context Hook

Runs on agent:start and session:start to write recent session data
to a JSON file that the Hermes Typewriter frontend can consume.

Output file: ~/.hermes/session_context.json
"""

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path


def get_hermes_home():
    """Get the Hermes home directory."""
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def get_recent_sessions(limit=15, source_filter=None):
    """Query the Hermes session database for recent sessions."""
    db_path = get_hermes_home() / "state.db"
    if not db_path.exists():
        return []
    
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        
        query = """
            SELECT id, title, source, started_at, message_count, model
            FROM sessions
            ORDER BY started_at DESC
            LIMIT ?
        """
        params = [limit]
        
        if source_filter:
            query = """
                SELECT id, title, source, started_at, message_count, model
                FROM sessions
                WHERE source = ?
                ORDER BY started_at DESC
                LIMIT ?
            """
            params = [source_filter, limit]
        
        cursor = conn.cursor()
        cursor.execute(query, params)
        
        sessions = []
        for row in cursor.fetchall():
            r = dict(row)
            # Convert timestamp to ISO format
            if r['started_at']:
                r['started_at_iso'] = datetime.fromtimestamp(r['started_at']).isoformat()
            # Generate a preview from the title or session_id
            if not r.get('title'):
                r['preview'] = f"Session {r['id'][:8]}..."
            sessions.append(r)
        
        conn.close()
        return sessions
    except Exception as e:
        print(f"[session-context hook] Error querying sessions: {e}")
        return []


def handle(event_type, context):
    """
    Hook handler for agent:start and session:start events.
    
    Writes session context to ~/.hermes/session_context.json
    """
    hermes_home = get_hermes_home()
    output_file = hermes_home / "session_context.json"
    
    # Get session info from context
    current_session_id = context.get("session_id", "")
    platform = context.get("platform", "")
    
    # Query recent sessions
    sessions = get_recent_sessions(limit=20)
    
    # Mark current session
    for s in sessions:
        s['is_current'] = (s['id'] == current_session_id)
    
    # Build output
    output = {
        "event": event_type,
        "timestamp": datetime.now().isoformat(),
        "current_session_id": current_session_id,
        "platform": platform,
        "sessions": sessions,
        "count": len(sessions)
    }
    
    # Write to file (atomic write)
    try:
        temp_file = output_file.with_suffix('.tmp')
        temp_file.write_text(json.dumps(output, indent=2, default=str))
        temp_file.replace(output_file)
        print(f"[session-context hook] Wrote {len(sessions)} sessions to {output_file}")
    except Exception as e:
        print(f"[session-context hook] Error writing file: {e}")


# For sync/async compatibility
async def async_handle(event_type, context):
    handle(event_type, context)

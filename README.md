# Message Scheduler (Enhanced Fork)

A supercharged version of the original Vencord **Message Scheduler** plugin — now with persistence, expanded time parsing, and automatic restoration after restarts. ❤️

## ✨ What’s New in This Fork?

This fork enhances the original plugin with several major improvements:

### ✔ Persistent Scheduled Messages  
- Scheduled messages are now saved using **Vencord’s DataStore API**.  
- Your schedules **survive Discord/Vencord restarts**.  
- Timers are automatically restored on startup.  
- Missed messages (while offline) are **sent immediately** when the plugin loads.

### ✔ Advanced Time Parsing  
Support for a much wider variety of time formats:

#### Relative Formats  
- `1h30m`  
- `2d`  
- `45s`  

#### Exact Time-of-Day Formats  
- `17h00`  
- `3:30pm`  
- `15:45`  

#### Combined & Extended Formats (New!)  
- `17h00` → send at 17h if isn't already passed, else for next day
- `17h00+3d` → send at 17h in 3days
- `+17h00` → send in 17 hours  
- `+17h00+3d` → send in 17 hours + 3 days  
- `17h00` → next occurrence of 17:00  
- `1h00` → next occurrence of 1:00  

These formats were **not supported** in the original plugin.

### ✔ Automatic Restoration on Plugin Startup  
When Vencord loads the plugin:
- All saved messages are reloaded.
- Future messages are rescheduled.
- Missed messages are sent instantly.
- DataStore is updated so only valid entries remain.

### ✔ Improved Internal Behavior  
- Timeout IDs are kept in memory only (not saved).  
- DataStore always stays clean and consistent.  
- Cancelling properly removes both stored and in-memory messages.  
- More robust handling of edge cases.

---

## 💬 Commands

### `/schedule`
Schedule a message.

**Options:**
- `message`: The content to send  
- `time`: Supported formats include:
  - `1h30m`
  - `12h00+2d`
  - `30s`
  - `3:30pm`, `15:45`
  - `17h00`
  - `+17h00`
  - `+17h00+3d`

### `/scheduled`
Show the list of scheduled messages for the current channel.

### `/cancel-scheduled`
Cancel a scheduled message.

**Option:**
- `index`: The message index from `/scheduled`

---

## ⚙️ Settings

### **Show Notifications**
Toggle whether toast notifications appear when messages are scheduled or sent.

---

## 📝 Behavior Notes

- Messages persist through restarts thanks to DataStore.  
- Missed messages aren’t lost — they send immediately.  
- Time formats like `17h00` automatically roll over to the next day if needed.  
- Combined delay formats (e.g., `+17h00+2d`) let you stack multiple modifiers.  
- Only valid timers are restored on startup.
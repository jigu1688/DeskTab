import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow as getCurrentWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import "./App.css";

const getLocalDatetimeString = (dateOrTimestamp) => {
  const date = new Date(dateOrTimestamp);
  const pad = (num) => String(num).padStart(2, "0");
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${yyyy}-${MM}-${dd}T${hh}:${mm}`;
};

// Helper functions to load/save notes from Rust local file storage
const getNotesList = async () => {
  try {
    const listStr = await invoke("load_notes");
    const parsed = JSON.parse(listStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Error loading notes:", e);
    return [];
  }
};

const saveNotesList = async (list) => {
  try {
    await invoke("save_notes", { notesJson: JSON.stringify(list) });
  } catch (e) {
    console.error("Error saving notes:", e);
  }
};

// Simple Markdown Inline Parser
const parseInlineMarkdown = (text) => {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>");
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
};

// Helper to parse hex to RGB
const hexToRgb = (hex) => {
  if (!hex) return null;
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  const fullHex = hex.replace(shorthandRegex, (m, r, g, b) => r + r + g + g + b + b);
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
};

// Helper to determine text color based on background luminance
const getTextColorForBg = (hex) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#1e293b";
  // Classic luminance formula
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? "#451a03" : "#f8fafc"; // Dark brown for light backgrounds, white for dark
};

// ==========================================
// 1. NOTES HUB COMPONENT (管理中心)
// ==========================================
function Hub() {
  const [notes, setNotes] = useState([]);
  const [activeTab, setActiveTab] = useState("active"); // "active" | "trash"
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedColor, setSelectedColor] = useState(null); // null | color name
  const [autostart, setAutostart] = useState(false);
  const [autoHide, setAutoHide] = useState(true);
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: null,
  });

  const showConfirm = (message, onConfirm, title = "操作确认") => {
    setConfirmModal({
      isOpen: true,
      title,
      message,
      onConfirm: () => {
        onConfirm();
        closeConfirm();
      }
    });
  };

  const closeConfirm = () => {
    setConfirmModal({
      isOpen: false,
      title: "",
      message: "",
      onConfirm: null,
    });
  };

  useEffect(() => {
    invoke("get_autostart").then(setAutostart).catch(console.error);
    const saved = localStorage.getItem("desktab_auto_hide");
    setAutoHide(saved !== "false");
  }, []);

  const handleToggleAutostart = async () => {
    const nextVal = !autostart;
    setAutostart(nextVal);
    await invoke("set_autostart", { enable: nextVal }).catch(console.error);
  };

  const handleToggleAutoHide = async () => {
    const nextVal = !autoHide;
    setAutoHide(nextVal);
    localStorage.setItem("desktab_auto_hide", String(nextVal));
    await emit("auto-hide-changed", { enabled: nextVal });
  };

  const refreshNotes = async () => {
    const list = await getNotesList();
    setNotes(list);
  };

  useEffect(() => {
    refreshNotes();
    // Poll updates every 2 seconds in case other windows modified file
    const interval = setInterval(refreshNotes, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleCreateNewNote = async () => {
    const newId = Date.now().toString();
    const list = await getNotesList();
    const newNote = {
      id: newId,
      content: "",
      color: "yellow",
      pinned: false,
      deleted: false,
      x: null,
      y: null,
      w: 300,
      h: 300,
    };
    const newList = [...list, newNote];
    await saveNotesList(newList);
    setNotes(newList);

    await invoke("create_note_window", {
      id: newId,
      x: null,
      y: null,
      w: 300,
      h: 300,
      alwaysOnTop: false,
    });
  };

  const handleOpenNote = async (note) => {
    await invoke("create_note_window", {
      id: note.id,
      x: note.x,
      y: note.y,
      w: note.w,
      h: note.h,
      alwaysOnTop: note.pinned,
    });
  };

  const handleRestoreNote = async (id, e) => {
    e.stopPropagation();
    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === id);
    if (index !== -1) {
      list[index].deleted = false;
      await saveNotesList(list);
      setNotes(list);
      // Spawn it
      const n = list[index];
      await invoke("create_note_window", {
        id: n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        alwaysOnTop: n.pinned,
      });
    }
  };

  const handleDeleteNoteFromHub = async (id, e) => {
    e.stopPropagation();
    showConfirm("确定要将这条便签移动到回收站吗？", async () => {
      const list = await getNotesList();
      const index = list.findIndex((n) => n.id === id);
      if (index !== -1) {
        list[index].deleted = true;
        list[index].pinned = false; // reset pin
        await saveNotesList(list);
        setNotes(list);
        // Emit global event to close window
        await emit("delete-note", { id });
      }
    }, "删除便签");
  };

  const handlePermanentlyDeleteNote = async (id, e) => {
    e.stopPropagation();
    showConfirm("确定要彻底删除这条便签吗？此操作不可撤销。", async () => {
      const list = await getNotesList();
      const newList = list.filter((n) => n.id !== id);
      await saveNotesList(newList);
      setNotes(newList);
    }, "彻底删除便签");
  };

  const handleEmptyTrash = async () => {
    showConfirm("确定要清空回收站的所有便签吗？", async () => {
      const list = await getNotesList();
      const newList = list.filter((n) => !n.deleted);
      await saveNotesList(newList);
      setNotes(newList);
    }, "清空回收站");
  };

  // Filters
  const filteredNotes = notes.filter((n) => {
    const matchesTab = activeTab === "trash" ? n.deleted : !n.deleted;
    const matchesSearch = (n.content || "").toLowerCase().includes(searchQuery.toLowerCase());
    const matchesColor = selectedColor ? (n.color || "yellow") === selectedColor : true;
    return matchesTab && matchesSearch && matchesColor;
  });

  const morandiColors = {
    yellow: { label: "柔黄", hex: "#fef3c7" },
    green: { label: "薄荷绿", hex: "#d1fae5" },
    blue: { label: "天空蓝", hex: "#e0f2fe" },
    purple: { label: "薰衣草", hex: "#f3e8ff" },
    pink: { label: "玫瑰粉", hex: "#ffe4e6" },
    grey: { label: "雅致灰", hex: "#f1f5f9" },
    dark: { label: "暗黑", hex: "#1e293b" },
  };

  return (
    <div className="hub-container">
      {/* Sidebar */}
      <div className="hub-sidebar">
        <div className="sidebar-title">DeskTab</div>
        <div 
          className={`sidebar-menu-item ${activeTab === "active" ? "active" : ""}`}
          onClick={() => { setActiveTab("active"); setSelectedColor(null); }}
        >
          📁 我的便签
        </div>
        <div 
          className={`sidebar-menu-item ${activeTab === "trash" ? "active" : ""}`}
          onClick={() => { setActiveTab("trash"); setSelectedColor(null); }}
        >
          🗑️ 回收站
        </div>

        <div className="sidebar-divider" />
        <div className="color-filters-title">颜色筛选</div>
        {Object.entries(morandiColors).map(([key, data]) => (
          <div 
            key={key}
            className={`color-filter-item ${selectedColor === key ? "active" : ""}`}
            onClick={() => setSelectedColor(selectedColor === key ? null : key)}
          >
            <span className="color-bullet" style={{ background: data.hex }} />
            {data.label}
          </div>
        ))}
        <div 
          className={`color-filter-item ${selectedColor === "custom" ? "active" : ""}`}
          onClick={() => setSelectedColor(selectedColor === "custom" ? null : "custom")}
        >
          <span className="color-bullet" style={{ background: "linear-gradient(135deg, #ff0055, #00ffcc, #9900ff)" }} />
          自定义
        </div>

        <div className="sidebar-divider" style={{ marginTop: "auto" }} />
        <div style={{ padding: "0 16px", marginBottom: "8px", fontSize: "12px", display: "flex", alignItems: "center", gap: "8px", color: "#64748b" }}>
          <input 
            type="checkbox" 
            id="autostart-chk"
            checked={autostart} 
            onChange={handleToggleAutostart} 
            style={{ cursor: "pointer" }}
          />
          <label htmlFor="autostart-chk" style={{ cursor: "pointer", userSelect: "none" }}>开机自启动</label>
        </div>
        <div style={{ padding: "0 16px", marginBottom: "16px", fontSize: "12px", display: "flex", alignItems: "center", gap: "8px", color: "#64748b" }}>
          <input 
            type="checkbox" 
            id="autohide-chk"
            checked={autoHide} 
            onChange={handleToggleAutoHide} 
            style={{ cursor: "pointer" }}
          />
          <label htmlFor="autohide-chk" style={{ cursor: "pointer", userSelect: "none" }}>贴边自动隐藏</label>
        </div>
      </div>

      {/* Main content */}
      <div className="hub-main">
        <div className="hub-header">
          <div className="hub-search-wrapper">
            🔍
            <input 
              type="text" 
              placeholder="搜索便签内容..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div>
            {activeTab === "active" ? (
              <button className="hub-btn primary" onClick={handleCreateNewNote}>
                ➕ 新建便签
              </button>
            ) : (
              <button 
                className="hub-btn danger" 
                onClick={handleEmptyTrash}
                disabled={filteredNotes.length === 0}
              >
                🗑️ 清空回收站
              </button>
            )}
          </div>
        </div>

        <div className="hub-content">
          {filteredNotes.length === 0 ? (
            <div className="empty-state">
              <span style={{ fontSize: "48px" }}>✏️</span>
              <div className="empty-state-text">没有找到符合条件的便签</div>
            </div>
          ) : (
            <div className="cards-grid">
              {filteredNotes.map((n) => (
                <div 
                  key={n.id}
                  className="note-card"
                  style={{ background: n.color === "custom" ? n.customColor : (morandiColors[n.color]?.hex || "#ffffff") }}
                  onClick={() => activeTab === "active" && handleOpenNote(n)}
                >
                  <div className="card-header">
                    {n.pinned && <span title="已置顶">📌</span>}
                    {n.reminder && <span title="已设置提醒">⏰</span>}
                  </div>
                  <div className="card-body">
                    {n.content || <em style={{ opacity: 0.4 }}>空白便签</em>}
                  </div>
                  <div className="card-footer">
                    <span>
                      {new Date(parseInt(n.id) || Date.now()).toLocaleDateString()}
                    </span>
                    {activeTab === "trash" ? (
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button className="hub-btn secondary" style={{ padding: "2px 6px", fontSize: "10px" }} onClick={(e) => handleRestoreNote(n.id, e)}>
                          恢复
                        </button>
                        <button className="hub-btn danger" style={{ padding: "2px 6px", fontSize: "10px", background: "#fecaca" }} onClick={(e) => handlePermanentlyDeleteNote(n.id, e)}>
                          删除
                        </button>
                      </div>
                    ) : (
                      <button 
                        className="hub-btn danger" 
                        style={{ padding: "2px 6px", fontSize: "10px", background: "#fee2e2" }} 
                        onClick={(e) => handleDeleteNoteFromHub(n.id, e)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {confirmModal.isOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-box">
            <div className="confirm-modal-header">
              <span>⚠️ {confirmModal.title}</span>
              <button className="confirm-modal-close" onClick={closeConfirm}>&times;</button>
            </div>
            <div className="confirm-modal-body">
              {confirmModal.message}
            </div>
            <div className="confirm-modal-footer">
              <button className="confirm-modal-btn cancel" onClick={closeConfirm}>取消</button>
              <button className="confirm-modal-btn confirm" onClick={confirmModal.onConfirm}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================
// 2. STICKY NOTE COMPONENT (单张便签)
// ==========================================
function Note({ noteId }) {
  const [content, setContent] = useState("");
  const [color, setColor] = useState("yellow");
  const [pinned, setPinned] = useState(false);
  const [reminder, setReminder] = useState(null); // Millisecond timestamp

  const [opacity, setOpacity] = useState(0.75);
  const [customColor, setCustomColor] = useState("");
  const [fontSize, setFontSize] = useState(14.5);
  const colorInputRef = useRef(null);
  const helpTriggerRef = useRef(null);
  const textareaRef = useRef(null);

  const [isCollapsed, setIsCollapsed] = useState(false);
  const isCollapsedRef = useRef(false);
  const expandedWidth = useRef(320);
  const expandedHeight = useRef(320);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef(null);

  const [showReminderPicker, setShowReminderPicker] = useState(false);
  const [showHelpPopover, setShowHelpPopover] = useState(false);
  const [editMode, setEditMode] = useState(true); // Edit vs Markdown Preview
  const [lastUpdated, setLastUpdated] = useState("");
  const [reminderInput, setReminderInput] = useState("");
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [activeSegment, setActiveSegment] = useState("minute"); // "year" | "month" | "day" | "hour" | "minute"
  const [autoHideEnabled, setAutoHideEnabled] = useState(true);

  const isPositioning = useRef(false);
  const isHidden = useRef(false);
  const originalPos = useRef(null);
  const currentPos = useRef({ x: 0, y: 0 });

  const updateTime = (id) => {
    const time = new Date(parseInt(id) || Date.now());
    const formatted = `${time.getMonth() + 1}月${time.getDate()}日 ${time
      .getHours()
      .toString()
      .padStart(2, "0")}:${time.getMinutes().toString().padStart(2, "0")}`;
    setLastUpdated(formatted);
  };

  // Load Note State
  useEffect(() => {
    const initNote = async () => {
      const list = await getNotesList();
      const note = list.find((n) => n.id === noteId);
      if (note) {
        setContent(note.content || "");
        setColor(note.color || "yellow");
        setPinned(note.pinned || false);
        setReminder(note.reminder || null);
        const defaultOpacity = note.color === "dark" ? 0.82 : 0.75;
        setOpacity(note.opacity !== undefined ? note.opacity : defaultOpacity);
        setCustomColor(note.customColor || "");
        setFontSize(note.fontSize || 14.5);
        updateTime(note.id);
        
        const appWindow = getCurrentWindow();
        const monitor = await currentMonitor();
        const scaleFactor = monitor ? monitor.scaleFactor : 1;

        const collapsed = note.isCollapsed || false;
        setIsCollapsed(collapsed);
        isCollapsedRef.current = collapsed;

        // note.w and note.h in database are physical pixels
        const wVal = note.w || 320 * scaleFactor;
        const hVal = note.h || 320 * scaleFactor;
        expandedWidth.current = wVal / scaleFactor;
        expandedHeight.current = hVal / scaleFactor;

        if (note.pinned) {
          appWindow.setAlwaysOnTop(true).catch(console.error);
        }
        if (note.x !== null && note.y !== null) {
          currentPos.current = { x: note.x, y: note.y };
        }
        if (note.reminder) {
          setReminderInput(getLocalDatetimeString(note.reminder));
        }

        if (collapsed) {
          await appWindow.setResizable(false).catch(console.error);
          await appWindow.setSize(new LogicalSize(expandedWidth.current, 40)).catch(console.error);
        } else {
          await appWindow.setResizable(true).catch(console.error);
          await appWindow.setSize(new LogicalSize(expandedWidth.current, expandedHeight.current)).catch(console.error);
        }
      }
    };
    initNote();
  }, [noteId]);

  // Listen to global delete-note event to close the window if deleted from Hub
  useEffect(() => {
    if (!noteId) return;

    const promise = listen("delete-note", (event) => {
      if (event.payload && event.payload.id === noteId) {
        getCurrentWindow().close().catch(console.error);
      }
    });

    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, [noteId]);

  // Load and listen to desktab_auto_hide global settings
  useEffect(() => {
    const saved = localStorage.getItem("desktab_auto_hide");
    setAutoHideEnabled(saved !== "false");

    const promise = listen("auto-hide-changed", (event) => {
      setAutoHideEnabled(event.payload.enabled);
    });

    return () => {
      promise.then((unlisten) => unlisten());
    };
  }, []);

  // Handle click outside to close popovers
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target)) {
        setShowSettingsMenu(false);
        setShowReminderPicker(false);
      }
      if (helpTriggerRef.current && !helpTriggerRef.current.contains(event.target)) {
        setShowHelpPopover(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  // Snapping & Auto-hide event listeners
  useEffect(() => {
    if (!noteId) return;

    const appWindow = getCurrentWindow();
    let isMounted = true;
    const unlisteners = [];

    const handleSnappingAndResize = async () => {
      try {
        // Size observer
        const unResize = await appWindow.onResized(async ({ payload: size }) => {
          if (isCollapsedRef.current) return;
          const list = await getNotesList();
          const index = list.findIndex((n) => n.id === noteId);
          if (index !== -1) {
            list[index].w = size.width;
            list[index].h = size.height;
            await saveNotesList(list);

            const monitor = await currentMonitor();
            const scaleFactor = monitor ? monitor.scaleFactor : 1;
            expandedWidth.current = size.width / scaleFactor;
            expandedHeight.current = size.height / scaleFactor;
          }
        });
        if (isMounted) unlisteners.push(unResize);

        // Move observer (With magnetic snapping)
        const unMove = await appWindow.onMoved(async ({ payload: pos }) => {
          currentPos.current = { x: pos.x, y: pos.y };
          if (isPositioning.current || isHidden.current) return;
          if (!autoHideEnabled) {
            // If auto-hide is disabled, we do not perform edge-snapping at all.
            // We just save the user's manual drag-and-drop coordinates and return early.
            const list = await getNotesList();
            const index = list.findIndex((n) => n.id === noteId);
            if (index !== -1) {
              list[index].x = pos.x;
              list[index].y = pos.y;
              await saveNotesList(list);
            }
            return;
          }

          const monitor = await currentMonitor();
          if (!monitor) return;

          const size = await appWindow.outerSize();
          const snapThreshold = 25 * monitor.scaleFactor; // 25 logical pixels to physical
          let newX = pos.x;
          let newY = pos.y;
          let snapped = false;

          // Snap Left
          if (Math.abs(pos.x) < snapThreshold) {
            newX = 0;
            snapped = true;
          }
          // Snap Right
          else if (Math.abs(pos.x + size.width - monitor.size.width) < snapThreshold) {
            newX = monitor.size.width - size.width;
            snapped = true;
          }

          // Snap Top
          if (Math.abs(pos.y) < snapThreshold) {
            newY = 0;
            snapped = true;
          }

          if (snapped) {
            isPositioning.current = true;
            try {
              await appWindow.setPosition(new PhysicalPosition(newX, newY));
            } catch (err) {
              console.error("Error setting window snap position:", err);
            } finally {
              isPositioning.current = false;
            }
          }

          // Save position
          const list = await getNotesList();
          const index = list.findIndex((n) => n.id === noteId);
          if (index !== -1) {
            list[index].x = newX;
            list[index].y = newY;
            await saveNotesList(list);
          }
        });
        if (isMounted) unlisteners.push(unMove);

        // Focus observer: automatically restore position if the window is focused while collapsed
        const unFocus = await appWindow.onFocused(async ({ payload: focused }) => {
          if (focused && isHidden.current && originalPos.current) {
            await appWindow.setPosition(new PhysicalPosition(originalPos.current.x, originalPos.current.y));
            await appWindow.setResizable(true).catch(console.error);
            isHidden.current = false;
            originalPos.current = null;
          }
        });
        if (isMounted) unlisteners.push(unFocus);
      } catch (err) {
        console.error("Error setting window listeners:", err);
      }
    };

    handleSnappingAndResize();

    return () => {
      isMounted = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [noteId]);

  // Collapsing (Auto-hide) when mouse leaves snapped edge
  const handleMouseLeave = async (e) => {
    if (isHidden.current) return;
    if (!autoHideEnabled) return;

    // If the mouse button is pressed (e.g., during dragging or text selection), do not collapse
    if (e && e.buttons > 0) return;

    const appWindow = getCurrentWindow();
    
    // Don't auto-hide if user is actively editing or if settings/reminder popovers are open
    if (showSettingsMenu || showReminderPicker) return;
    const activeEl = document.activeElement;
    const isEditing = activeEl && (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT");
    if (isEditing) return;

    const monitor = await currentMonitor();
    if (!monitor) return;

    const pos = currentPos.current;
    const size = await appWindow.outerSize();
    const snapThreshold = 30 * monitor.scaleFactor; // 30 logical pixels threshold

    let edge = null;
    let targetX = pos.x;
    let targetY = pos.y;

    // Check Left Edge
    if (Math.abs(pos.x) < snapThreshold) {
      edge = "left";
      targetX = 0;
    }
    // Check Right Edge
    else if (Math.abs(pos.x + size.width - monitor.size.width) < snapThreshold) {
      edge = "right";
      targetX = monitor.size.width - size.width;
    }
    // Check Top Edge
    else if (Math.abs(pos.y) < snapThreshold) {
      edge = "top";
      targetY = 0;
    }

    if (edge) {
      isHidden.current = true;
      originalPos.current = { x: targetX, y: targetY, edge };
      
      let hideX = targetX;
      let hideY = targetY;
      const offset = 12 * monitor.scaleFactor; // keep 12px visible (above OS resize border)

      if (edge === "left") {
        hideX = -size.width + offset;
      } else if (edge === "right") {
        hideX = monitor.size.width - offset;
      } else if (edge === "top") {
        hideY = -size.height + offset;
      }

      // Disable resizing so OS does not capture mouse events on border with a resize cursor
      await appWindow.setResizable(false).catch(console.error);

      // Hide the window
      await appWindow.setPosition(new PhysicalPosition(hideX, hideY));

      // Update and save the snapped position in the config file
      const list = await getNotesList();
      const index = list.findIndex((n) => n.id === noteId);
      if (index !== -1) {
        list[index].x = targetX;
        list[index].y = targetY;
        await saveNotesList(list);
      }
    }
  };

  const handleMouseEnter = async () => {
    if (!isHidden.current || !originalPos.current) return;
    const appWindow = getCurrentWindow();
    
    // Restore window position
    await appWindow.setPosition(new PhysicalPosition(originalPos.current.x, originalPos.current.y));
    
    // Re-enable resizing
    await appWindow.setResizable(true).catch(console.error);
    
    isHidden.current = false;
    originalPos.current = null;
  };

  // Toggle Pin-on-top
  const handleTogglePin = async () => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    try {
      const appWindow = getCurrentWindow();
      await appWindow.setAlwaysOnTop(nextPinned);
    } catch (err) {
      console.error(err);
    }

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].pinned = nextPinned;
      await saveNotesList(list);
    }
  };

  // Change Morandi color
  const handleSelectColor = async (selectedColor) => {
    setColor(selectedColor);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].color = selectedColor;
      if (list[index].opacity === undefined) {
        const nextOpacity = selectedColor === "dark" ? 0.82 : 0.75;
        setOpacity(nextOpacity);
      }
      await saveNotesList(list);
    }
  };

  // Change Background Opacity
  const handleOpacityChange = async (e) => {
    const val = parseFloat(e.target.value);
    setOpacity(val);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].opacity = val;
      await saveNotesList(list);
    }
  };

  // Markdown Formatter Helper
  const insertMarkdownFormat = (prefix, suffix = "") => {
    if (!textareaRef.current) return;
    const textarea = textareaRef.current;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;

    const selection = text.substring(start, end);
    let replacement = "";

    if (prefix === "- [ ] ") {
      if (selection) {
        replacement = selection
          .split("\n")
          .map((line) => line.startsWith("- [ ] ") ? line : `- [ ] ${line}`)
          .join("\n");
      } else {
        replacement = "- [ ] ";
      }
    } else if (prefix === "# ") {
      if (selection) {
        replacement = selection
          .split("\n")
          .map((line) => line.startsWith("# ") ? line : `# ${line}`)
          .join("\n");
      } else {
        replacement = "# ";
      }
    } else {
      replacement = `${prefix}${selection}${suffix}`;
    }

    const newContent = text.substring(0, start) + replacement + text.substring(end);
    setContent(newContent);

    const updateNotes = async () => {
      const list = await getNotesList();
      const index = list.findIndex((n) => n.id === noteId);
      if (index !== -1) {
        list[index].content = newContent;
        await saveNotesList(list);
      }
    };
    updateNotes();

    setTimeout(() => {
      textarea.focus();
      const offset = prefix.length + (selection ? selection.length : 0) + suffix.length;
      textarea.setSelectionRange(start + offset, start + offset);
    }, 50);
  };

  // Key Down Handlers
  const handleKeyDown = (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      insertMarkdownFormat("**", "**");
    }
    if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      insertMarkdownFormat("*", "*");
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      insertMarkdownFormat("- [ ] ");
    }
    if (e.ctrlKey && e.key.toLowerCase() === "h") {
      e.preventDefault();
      insertMarkdownFormat("# ");
    }
  };

  const handleFontSizeIncrease = async () => {
    const nextSize = Math.min(28, fontSize + 1);
    setFontSize(nextSize);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].fontSize = nextSize;
      await saveNotesList(list);
    }
  };

  const handleFontSizeDecrease = async () => {
    const nextSize = Math.max(12, fontSize - 1);
    setFontSize(nextSize);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].fontSize = nextSize;
      await saveNotesList(list);
    }
  };

  // Change Custom Color via Native Color Picker
  const handleCustomColorClick = () => {
    if (colorInputRef.current) {
      colorInputRef.current.click();
    }
  };

  const handleCustomColorChange = async (e) => {
    const val = e.target.value;
    setCustomColor(val);
    setColor("custom");

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].color = "custom";
      list[index].customColor = val;
      await saveNotesList(list);
    }
  };

  // Save content
  const handleContentChange = async (e) => {
    const val = e.target.value;
    setContent(val);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].content = val;
      await saveNotesList(list);
    }
  };

  // Checklist handler inside preview mode
  const handleToggleChecklist = async (lineIndex, isChecked) => {
    const lines = content.split("\n");
    const line = lines[lineIndex];
    if (isChecked) {
      lines[lineIndex] = line.replace("- [ ]", "- [x]");
    } else {
      lines[lineIndex] = line.replace("- [x]", "- [ ]");
    }
    const newContent = lines.join("\n");
    setContent(newContent);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].content = newContent;
      await saveNotesList(list);
    }
  };

  // Delete note (Move to Trash)
  const handleDeleteNote = async () => {
    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].deleted = true;
      list[index].pinned = false; // reset pin
      await saveNotesList(list);
    }

    try {
      const appWindow = getCurrentWindow();
      await appWindow.close();
    } catch (err) {
      console.error(err);
    }
  };

  // Close note window (Keep note saved in active list)
  const handleCloseNote = async () => {
    try {
      const appWindow = getCurrentWindow();
      await appWindow.close();
    } catch (err) {
      console.error(err);
    }
  };

  // Sync selectedDate and reminderInput when picker opens
  useEffect(() => {
    if (showReminderPicker) {
      const initial = reminder ? new Date(reminder) : new Date();
      setSelectedDate(initial);
      setReminderInput(getLocalDatetimeString(initial));
    }
  }, [showReminderPicker, reminder]);

  const handleIncrement = () => {
    const newDate = new Date(selectedDate);
    if (activeSegment === "year") {
      newDate.setFullYear(newDate.getFullYear() + 1);
    } else if (activeSegment === "month") {
      newDate.setMonth(newDate.getMonth() + 1);
    } else if (activeSegment === "day") {
      newDate.setDate(newDate.getDate() + 1);
    } else if (activeSegment === "hour") {
      newDate.setHours(newDate.getHours() + 1);
    } else if (activeSegment === "minute") {
      newDate.setMinutes(newDate.getMinutes() + 1);
    }
    setSelectedDate(newDate);
    setReminderInput(getLocalDatetimeString(newDate));
  };

  const handleDecrement = () => {
    const newDate = new Date(selectedDate);
    if (activeSegment === "year") {
      newDate.setFullYear(newDate.getFullYear() - 1);
    } else if (activeSegment === "month") {
      newDate.setMonth(newDate.getMonth() - 1);
    } else if (activeSegment === "day") {
      newDate.setDate(newDate.getDate() - 1);
    } else if (activeSegment === "hour") {
      newDate.setHours(newDate.getHours() - 1);
    } else if (activeSegment === "minute") {
      newDate.setMinutes(newDate.getMinutes() - 1);
    }
    setSelectedDate(newDate);
    setReminderInput(getLocalDatetimeString(newDate));
  };

  // Alarm settings
  const handleSaveReminder = async () => {
    if (!reminderInput) return;
    const timeMs = new Date(reminderInput).getTime();
    setReminder(timeMs);
    setShowReminderPicker(false);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].reminder = timeMs;
      list[index].reminder_triggered = false;
      await saveNotesList(list);
    }
  };

  const handleClearReminder = async () => {
    setReminder(null);
    setReminderInput("");
    setShowReminderPicker(false);

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].reminder = null;
      list[index].reminder_triggered = false;
      await saveNotesList(list);
    }
  };

  const handleCreateNewNote = async () => {
    const newId = Date.now().toString();
    try {
      await invoke("create_note_window", {
        id: newId,
        x: null,
        y: null,
        w: 300,
        h: 300,
        alwaysOnTop: false,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const handleOpenHub = async () => {
    try {
      await invoke("open_hub");
    } catch (err) {
      console.error(err);
    }
  };

  const getNoteTitle = () => {
    if (!content || content.trim() === "") {
      return "空白便签";
    }
    const firstLine = content.split("\n")[0].trim();
    let cleanTitle = firstLine
      .replace(/^#+\s+/, "")
      .replace(/^-\s+\[[ x]\]\s+/, "")
      .replace(/^[-*]\s+/, "")
      .replace(/\*\*|[*_`~]/g, "");
    
    if (cleanTitle.trim() === "") {
      return "无标题便签";
    }
    return cleanTitle.length > 15 ? cleanTitle.substring(0, 15) + "..." : cleanTitle;
  };

  const toggleCollapse = async () => {
    const appWindow = getCurrentWindow();
    const nextCollapsed = !isCollapsed;
    setIsCollapsed(nextCollapsed);
    isCollapsedRef.current = nextCollapsed;

    const size = await appWindow.innerSize();
    const monitor = await currentMonitor();
    const scaleFactor = monitor ? monitor.scaleFactor : 1;

    const logicalWidth = size.width / scaleFactor;
    const logicalHeight = size.height / scaleFactor;

    if (nextCollapsed) {
      // Save current size to restore later
      expandedWidth.current = logicalWidth;
      expandedHeight.current = logicalHeight;

      await appWindow.setResizable(false).catch(console.error);
      await appWindow.setSize(new LogicalSize(logicalWidth, 40)).catch(console.error);
    } else {
      await appWindow.setSize(new LogicalSize(expandedWidth.current, expandedHeight.current)).catch(console.error);
      await appWindow.setResizable(true).catch(console.error);
    }

    const list = await getNotesList();
    const index = list.findIndex((n) => n.id === noteId);
    if (index !== -1) {
      list[index].isCollapsed = nextCollapsed;
      list[index].w = size.width;
      if (!nextCollapsed) {
        list[index].h = expandedHeight.current * scaleFactor;
      }
      await saveNotesList(list);
    }
  };

  const handleMouseDown = async (e) => {
    // Only drag on left click and ignore click on buttons/inputs/pickers
    if (e.button === 0 && !e.target.closest("button") && !e.target.closest("input") && !e.target.closest(".segment")) {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.startDragging();
      } catch (err) {
        console.error("Error starting dragging:", err);
      }
    }
  };

  // Parse Markdown & Checklist rendering
  const renderMarkdown = () => {
    const lines = content.split("\n");
    return lines.map((line, idx) => {
      // Checklist
      if (line.startsWith("- [ ] ") || line.startsWith("- [x] ")) {
        const checked = line.startsWith("- [x] ");
        const text = line.substring(6);
        return (
          <div key={idx} className="markdown-checklist-item">
            <input
              type="checkbox"
              checked={checked}
              onChange={() => handleToggleChecklist(idx, !checked)}
            />
            <span className={checked ? "checked" : ""}>{parseInlineMarkdown(text)}</span>
          </div>
        );
      }
      // Bullets
      if (line.startsWith("- ") || line.startsWith("* ")) {
        return (
          <li key={idx} className="markdown-bullet-item">
            {parseInlineMarkdown(line.substring(2))}
          </li>
        );
      }
      // H3
      if (line.startsWith("# ")) {
        return <h3 key={idx} className="markdown-h3">{parseInlineMarkdown(line.substring(2))}</h3>;
      }
      // H4
      if (line.startsWith("## ")) {
        return <h4 key={idx} className="markdown-h4">{parseInlineMarkdown(line.substring(3))}</h4>;
      }
      // Empty Line
      if (line.trim() === "") {
        return <div key={idx} className="markdown-empty-line" />;
      }
      // P
      return <p key={idx} className="markdown-p">{parseInlineMarkdown(line)}</p>;
    });
  };

  const isCustomColor = color === "custom" && customColor;
  const customStyles = isCustomColor ? {
    "--note-bg-rgb": (() => {
      const rgb = hexToRgb(customColor);
      return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "254, 243, 199";
    })(),
    "--note-border-rgb": (() => {
      const rgb = hexToRgb(customColor);
      return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "245, 158, 11";
    })(),
    "--note-header-rgb": (() => {
      const rgb = hexToRgb(customColor);
      return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : "254, 243, 199";
    })(),
    "--note-text": getTextColorForBg(customColor),
    "--button-hover": getTextColorForBg(customColor) === "#f8fafc" ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)"
  } : {};

  return (
    <div 
      className={`note-container morandi-${color} ${pinned ? "pinned" : ""} ${isCollapsed ? "is-collapsed" : ""}`}
      style={{
        "--note-opacity": opacity,
        "--note-header-opacity": Math.min(1.0, opacity + 0.1),
        ...customStyles
      }}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
    >
      {/* Header bar */}
      <div 
        className="note-header" 
        onMouseDown={handleMouseDown}
        onDoubleClick={toggleCollapse}
      >
        <div className="header-left">
          <button className="action-btn" onClick={handleCreateNewNote} title="新建便签">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          
          {/* Settings Trigger & Popover */}
          <div className="settings-trigger" ref={settingsMenuRef}>
            <button 
              className={`action-btn ${showSettingsMenu ? "active" : ""}`} 
              onClick={() => setShowSettingsMenu(!showSettingsMenu)}
              title="功能菜单与设置"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
            
            {showSettingsMenu && (
              <div className="settings-menu-popover">
                {/* 1. Color Selector */}
                <div className="settings-menu-section">
                  <div className="settings-section-title">便签主题颜色</div>
                  <div className="color-dots-row">
                    {["yellow", "green", "blue", "purple", "pink", "grey", "dark"].map((c) => (
                      <div
                        key={c}
                        className={`color-dot ${color === c ? "active" : ""}`}
                        style={{
                          background: c === "dark" 
                            ? "#1e293b" 
                            : c === "yellow" 
                            ? "#fef3c7" 
                            : c === "green" 
                            ? "#d1fae5" 
                            : c === "blue" 
                            ? "#e0f2fe" 
                            : c === "purple" 
                            ? "#f3e8ff" 
                            : c === "pink" 
                            ? "#ffe4e6" 
                            : "#f1f5f9"
                        }}
                        onClick={() => handleSelectColor(c)}
                      />
                    ))}
                    <div
                      className={`color-dot custom-color-dot ${color === "custom" ? "active" : ""}`}
                      style={{
                        background: customColor || "linear-gradient(135deg, #ff0055, #00ffcc, #9900ff)"
                      }}
                      onClick={handleCustomColorClick}
                      title="自定义颜色"
                    >
                      {!customColor && <span className="custom-color-plus">+</span>}
                    </div>
                  </div>
                  <div className="opacity-slider-container">
                    <span className="opacity-label">透明度</span>
                    <input
                      type="range"
                      min="0.1"
                      max="1.0"
                      step="0.05"
                      value={opacity}
                      onChange={handleOpacityChange}
                      className="opacity-slider"
                    />
                    <span className="opacity-value">{Math.round(opacity * 100)}%</span>
                  </div>
                  <input 
                    type="color"
                    ref={colorInputRef}
                    value={customColor || "#ffffff"}
                    onChange={handleCustomColorChange}
                    style={{ display: "none" }}
                  />
                </div>
                
                <div className="settings-menu-divider" />

                {/* 2. Alarm Reminder */}
                <div className="settings-menu-section">
                  <div 
                    className={`settings-menu-row ${reminder ? "active" : ""}`}
                    onClick={() => {
                      const nextVal = !showReminderPicker;
                      setShowReminderPicker(nextVal);
                      if (nextVal && !reminderInput) {
                        setReminderInput(getLocalDatetimeString(Date.now()));
                      }
                    }}
                  >
                    <span>⏰ {reminder ? "查看/修改提醒" : "设置定时提醒"}</span>
                    <span className="expand-arrow">{showReminderPicker ? "▲" : "▼"}</span>
                  </div>

                  {showReminderPicker && (() => {
                    const padVal = (num) => String(num).padStart(2, "0");
                    const year = selectedDate.getFullYear();
                    const month = selectedDate.getMonth() + 1;
                    const day = selectedDate.getDate();
                    const hour = selectedDate.getHours();
                    const minute = selectedDate.getMinutes();

                    return (
                      <div className="settings-reminder-picker-container">
                        <div className="segmented-datetime-picker">
                          <div className="segments-container">
                            <span className={`segment ${activeSegment === "year" ? "active" : ""}`} onClick={() => setActiveSegment("year")}>{year}</span>
                            <span className="separator">/</span>
                            <span className={`segment ${activeSegment === "month" ? "active" : ""}`} onClick={() => setActiveSegment("month")}>{padVal(month)}</span>
                            <span className="separator">/</span>
                            <span className={`segment ${activeSegment === "day" ? "active" : ""}`} onClick={() => setActiveSegment("day")}>{padVal(day)}</span>
                            <span className="segment-spacer" />
                            <span className={`segment ${activeSegment === "hour" ? "active" : ""}`} onClick={() => setActiveSegment("hour")}>{padVal(hour)}</span>
                            <span className="separator">:</span>
                            <span className={`segment ${activeSegment === "minute" ? "active" : ""}`} onClick={() => setActiveSegment("minute")}>{padVal(minute)}</span>
                          </div>
                          <div className="spin-buttons">
                            <button className="spin-btn" onClick={handleIncrement} title="增加当前项">▲</button>
                            <button className="spin-btn" onClick={handleDecrement} title="减少当前项">▼</button>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: "6px", width: "100%" }}>
                          <button className="save-btn" style={{ flex: 1, padding: "4px 8px", fontSize: "11px", border: "none", borderRadius: "4px", background: "#3b82f6", color: "white", cursor: "pointer" }} onClick={handleSaveReminder}>保存</button>
                          {reminder && (
                            <button className="clear-btn" style={{ padding: "4px 8px", fontSize: "11px", border: "none", borderRadius: "4px", background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", cursor: "pointer" }} onClick={handleClearReminder}>清除</button>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="settings-menu-divider" />

                {/* 3. Open Hub */}
                <div 
                  className="settings-menu-row"
                  onClick={() => {
                    handleOpenHub();
                    setShowSettingsMenu(false);
                  }}
                >
                  <span>📁 便签管理中心</span>
                </div>
              </div>
            )}
          </div>
          
          {/* Collapsed title shown on the left */}
          {isCollapsed && <div className="collapsed-title">{getNoteTitle()}</div>}
        </div>

        {/* Expanded title shown in the center when not hovered */}
        {!isCollapsed && <div className="expanded-title-center">{getNoteTitle()}</div>}

        <div className="header-right">
          {/* Edit Mode Toggle */}
          <button 
            className={`action-btn ${!editMode ? "active" : ""}`}
            onClick={() => setEditMode(!editMode)}
            title={editMode ? "切换为预览模式" : "切换为编辑模式"}
          >
            {editMode ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            )}
          </button>

          {/* Pin */}
          <button 
            className={`action-btn ${pinned ? "active" : ""}`} 
            onClick={handleTogglePin}
            title={pinned ? "取消置顶" : "置顶便签"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: pinned ? "rotate(45deg)" : "none", transition: "transform 0.2s" }}>
              <path d="M21 10V6M3 14v4M12 3v18M16 6l-8 8"></path>
            </svg>
          </button>

          {/* Delete note (Move to Trash) */}
          <button className="action-btn" onClick={handleDeleteNote} title="删除便签">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          
          {/* Close Note Window */}
          <button className="action-btn close" onClick={handleCloseNote} title="关闭窗口">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      
      {/* Body area */}
      <div className="note-body">
        {editMode ? (
          <div className="editor-wrapper">
            <div className="editor-toolbar">
              <button 
                className="editor-tool-btn" 
                onClick={() => insertMarkdownFormat("- [ ] ")}
                title="待办清单 (Ctrl+Shift+C)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 11 12 14 22 4"></polyline>
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
                </svg>
              </button>
              
              <button 
                className="editor-tool-btn" 
                onClick={() => insertMarkdownFormat("# ")}
                title="大标题 (Ctrl+H)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="12" x2="20" y2="12"></line>
                  <line x1="4" y1="4" x2="4" y2="20"></line>
                  <line x1="20" y1="4" x2="20" y2="20"></line>
                </svg>
              </button>
              
              <button 
                className="editor-tool-btn" 
                onClick={() => insertMarkdownFormat("**", "**")}
                title="加粗文字 (Ctrl+B)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
                  <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"></path>
                </svg>
              </button>

              <button 
                className="editor-tool-btn" 
                onClick={() => insertMarkdownFormat("*", "*")}
                title="斜体文字 (Ctrl+I)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="19" y1="4" x2="10" y2="4"></line>
                  <line x1="14" y1="20" x2="5" y2="20"></line>
                  <line x1="15" y1="4" x2="9" y2="20"></line>
                </svg>
              </button>

              <div className="editor-tool-divider" />

              <div className="font-size-adjuster">
                <button 
                  className="editor-tool-btn font-size-btn" 
                  onClick={handleFontSizeDecrease}
                  title="减小字号"
                  disabled={fontSize <= 12}
                >
                  A-
                </button>
                <span className="font-size-display">{fontSize}px</span>
                <button 
                  className="editor-tool-btn font-size-btn" 
                  onClick={handleFontSizeIncrease}
                  title="增大字号"
                  disabled={fontSize >= 28}
                >
                  A+
                </button>
              </div>
              
              <div className="editor-tool-spacer" />
              
              <div className="markdown-help-trigger" ref={helpTriggerRef}>
                <button 
                  className={`editor-tool-btn help-btn ${showHelpPopover ? "active" : ""}`}
                  onClick={() => setShowHelpPopover(!showHelpPopover)}
                  title="Markdown 语法帮助"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                </button>
                
                {showHelpPopover && (
                  <div className="markdown-help-popover">
                    <div className="help-title">Markdown 快速指南</div>
                    <div className="help-item">
                      <span className="help-code"># 标题</span>
                      <span className="help-desc">三级大标题</span>
                    </div>
                    <div className="help-item">
                      <span className="help-code">## 标题</span>
                      <span className="help-desc">四级小标题</span>
                    </div>
                    <div className="help-item">
                      <span className="help-code">**文字**</span>
                      <span className="help-desc">加粗显示文字</span>
                    </div>
                    <div className="help-item">
                      <span className="help-code">*文字*</span>
                      <span className="help-desc">斜体显示文字</span>
                    </div>
                    <div className="help-item">
                      <span className="help-code">- [ ] 待办</span>
                      <span className="help-desc">可勾选的待办项</span>
                    </div>
                    <div className="help-item">
                      <span className="help-code">- 列表项</span>
                      <span className="help-desc">圆点无序列表</span>
                    </div>
                    <div className="help-tips">提示：在预览模式下双击便签空白处，即可快速切回编辑状态。</div>
                  </div>
                )}
              </div>
            </div>
            
            <textarea
              ref={textareaRef}
              className="note-textarea"
              value={content}
              onChange={handleContentChange}
              onKeyDown={handleKeyDown}
              placeholder="记点什么吧... 可在上方栏一键插入待办或标题"
              spellCheck="false"
              style={{ fontSize: `${fontSize}px` }}
            />
          </div>
        ) : (
          <div 
            className="markdown-preview-container" 
            onDoubleClick={() => setEditMode(true)}
            style={{ fontSize: `${fontSize}px` }}
          >
            {content.trim() === "" ? (
              <em style={{ opacity: 0.4 }}>双击或点击右上角按钮以编辑此空白便签...</em>
            ) : (
              renderMarkdown()
            )}
          </div>
        )}
      </div>
      
      {/* Footer bar */}
      <div className="note-footer">
        更新于 {lastUpdated}
      </div>
    </div>
  );
}

// ==========================================
// 3. MAIN ROUTER / ORCHESTRATOR
// ==========================================
function App() {
  const [route, setRoute] = useState({ type: "loading", id: null });
  const isMainRestored = useRef(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const label = appWindow.label;

    if (label === "hub") {
      setRoute({ type: "hub", id: null });
    } else if (label.startsWith("note_")) {
      const id = label.substring(5);
      setRoute({ type: "note", id });
    } else {
      // Default window setup (Main loader)
      const setupMainWindow = async () => {
        if (isMainRestored.current) return;
        isMainRestored.current = true;

        const list = await getNotesList();
        // Remove permanently deleted items if they slip through, or just filter active ones
        const activeNotes = list.filter((n) => !n.deleted);

        if (activeNotes.length === 0) {
          // If no active notes exist, create a new one
          const newId = Date.now().toString();
          const defaultNote = {
            id: newId,
            content: "",
            color: "yellow",
            pinned: false,
            deleted: false,
            x: null,
            y: null,
            w: 320,
            h: 320,
          };
          const updatedList = [...list.filter(n => n.deleted), defaultNote]; // keep trash
          await saveNotesList(updatedList);
          
          setRoute({ type: "note", id: newId });
        } else {
          // Load first active note in the main window
          const firstNote = activeNotes[0];
          setRoute({ type: "note", id: firstNote.id });

          // Spawn other active note windows in the background
          for (let i = 1; i < activeNotes.length; i++) {
            const n = activeNotes[i];
            invoke("create_note_window", {
              id: n.id,
              x: n.x,
              y: n.y,
              w: n.w,
              h: n.h,
              alwaysOnTop: n.pinned,
            }).catch((err) => console.error("Error spawning note window:", err));
          }
        }
      };
      setupMainWindow();
    }
  }, []);

  if (route.type === "loading") {
    return null;
  }

  if (route.type === "hub") {
    return <Hub />;
  }

  return <Note noteId={route.id} />;
}

export default App;

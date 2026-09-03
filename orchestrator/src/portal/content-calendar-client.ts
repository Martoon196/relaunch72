/**
 * Dependency-free progressive enhancement for durable TEST calendar commands.
 * Native forms remain the baseline; this layer adds pointer/touch/keyboard
 * confirmation, same-origin saving state and deterministic visual rollback.
 */

export const CONTENT_CALENDAR_CLIENT_ROUTE = '/portal/assets/content-calendar.js' as const;
export const CONTENT_CALENDAR_CLIENT_ASSET_PATH = CONTENT_CALENDAR_CLIENT_ROUTE;

export const CONTENT_CALENDAR_CLIENT_SOURCE = String.raw`(() => {
  'use strict';

  const codePointCount = (value) => Array.from(String(value || '')).length;

  const enhanceCalendar = (root) => {
    root.classList.add('ccal-enhanced');
    const live = root.querySelector('[data-calendar-live]');
    const scroll = root.querySelector('.ccal-scroll');
    const days = Array.from(root.querySelectorAll('[data-calendar-day]'));
    const handles = Array.from(root.querySelectorAll('[data-calendar-move-handle]'));
    const sheet = root.querySelector('[data-calendar-move-sheet]');
    const sheetDate = sheet && sheet.querySelector('[data-calendar-sheet-date]');
    const sheetTime = sheet && sheet.querySelector('[data-calendar-sheet-time]');
    const sheetApply = sheet && sheet.querySelector('[data-calendar-sheet-apply]');
    const sheetCancel = sheet && sheet.querySelector('[data-calendar-sheet-cancel]');
    const sheetCopy = sheet && sheet.querySelector('[data-calendar-sheet-copy]');
    const sheetDurableFields = sheet && sheet.querySelector('[data-calendar-sheet-durable-fields]');
    const sheetReason = sheet && sheet.querySelector('[data-calendar-sheet-reason]');
    const sheetConfirm = sheet && sheet.querySelector('[data-calendar-sheet-confirm]');
    let lifted = null;
    let pointerState = null;
    let sheetCard = null;
    let sheetReturnFocus = null;
    let sheetInert = [];
    const POINTER_THRESHOLD = 6;

    const announce = (message) => {
      if (!live) return;
      live.textContent = '';
      window.setTimeout(() => { live.textContent = message; }, 20);
    };

    const sameOriginUrl = (value) => {
      try {
        const url = new URL(value, window.location.href);
        return url.origin === window.location.origin && url.pathname.startsWith('/portal/') ? url : null;
      } catch {
        return null;
      }
    };

    const setFormStatus = (form, message) => {
      const status = form && form.querySelector('[data-calendar-form-status]');
      if (status) status.textContent = message;
      announce(message);
    };

    const dayLabel = (day) => day ? (day.getAttribute('aria-label') || day.dataset.date || 'day') : 'day';
    const cardLabel = (card) => {
      const heading = card && card.querySelector('h3');
      return heading ? heading.textContent.trim() : 'TEST plan';
    };
    const dayIndex = (day) => days.indexOf(day);
    const dayForCard = (card) => card && card.closest('[data-calendar-day]');

    const minutesFromCard = (card) => {
      const label = card && card.querySelector('.ccal-time');
      const match = label && /^(\d{2}):(\d{2})$/.exec(label.textContent.trim());
      return match ? (Number(match[1]) * 60) + Number(match[2]) : 9 * 60;
    };

    const clampMinutes = (value) => Math.max(0, Math.min(23 * 60 + 30, value));
    const timeValue = (minutes) => {
      const safe = clampMinutes(minutes);
      return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
    };

    const clearTargets = () => {
      days.forEach((day) => day.removeAttribute('data-preview-drop-target'));
      if (lifted && lifted.card) lifted.card.removeAttribute('data-preview-target-label');
    };

    const setTarget = (day, minutes) => {
      if (!lifted || !day || dayIndex(day) < 0) return false;
      const nextMinutes = clampMinutes(minutes);
      if (lifted.targetDay === day && lifted.minutes === nextMinutes
        && day.hasAttribute('data-preview-drop-target')) return true;
      clearTargets();
      lifted.targetDay = day;
      lifted.minutes = nextMinutes;
      day.setAttribute('data-preview-drop-target', 'true');
      lifted.card.setAttribute('data-preview-target-label', dayLabel(day) + ' at ' + timeValue(lifted.minutes));
      announce(cardLabel(lifted.card) + ' preview target: ' + dayLabel(day) + ' at ' + timeValue(lifted.minutes) + '. Press Space or Enter to place, or Escape to cancel.');
      return true;
    };

    const beginLift = (handle, restoreFocus) => {
      const card = handle && handle.closest('[data-calendar-slot]');
      const originDay = dayForCard(card);
      if (!card || !originDay) return false;
      if (lifted) {
        lifted.card.removeAttribute('data-preview-moving');
        lifted.handle.setAttribute('aria-pressed', 'false');
        clearTargets();
      }
      lifted = {
        card,
        handle,
        originDay,
        targetDay: null,
        minutes: minutesFromCard(card),
        restoreFocus: restoreFocus !== false,
      };
      card.setAttribute('data-preview-moving', 'true');
      handle.setAttribute('aria-pressed', 'true');
      setTarget(originDay, lifted.minutes);
      announce(cardLabel(card) + ' picked up for a browser-only TEST preview. Use Left and Right for day, Up and Down for 30-minute time steps, then Space or Enter to place.');
      return true;
    };

    const finishLift = (message) => {
      if (!lifted) return;
      const state = lifted;
      lifted = null;
      state.card.removeAttribute('data-preview-moving');
      state.card.removeAttribute('data-preview-target-label');
      state.handle.setAttribute('aria-pressed', 'false');
      clearTargets();
      if (state.restoreFocus && state.handle.isConnected) state.handle.focus();
      if (message) announce(message);
    };

    const ensureEmptyState = (day) => {
      const container = day && day.querySelector('.ccal-day-slots');
      if (!container) return;
      const hasCards = Boolean(container.querySelector('[data-calendar-slot]'));
      const empty = container.querySelector('.ccal-empty-day');
      if (hasCards && empty) empty.remove();
      if (!hasCards && !empty) {
        const placeholder = document.createElement('div');
        placeholder.className = 'ccal-empty-day';
        const text = document.createElement('span');
        text.textContent = root.dataset.calendarMode === 'month' ? '—' : 'No TEST plans';
        placeholder.appendChild(text);
        container.appendChild(placeholder);
      }
    };

    const applyMove = (card, targetDay, minutes, restoreFocus) => {
      const originDay = dayForCard(card);
      const targetContainer = targetDay && targetDay.querySelector('.ccal-day-slots');
      const date = targetDay && targetDay.dataset.date;
      if (!originDay || !targetContainer || !date) {
        announce('That preview destination is unavailable. Nothing changed.');
        return false;
      }
      const label = timeValue(minutes);
      const wallTime = date + 'T' + label;
      targetContainer.appendChild(card);
      card.dataset.scheduledFor = wallTime;
      card.dataset.previewWallTime = 'true';
      const time = card.querySelector('.ccal-time');
      if (time) {
        time.textContent = label;
        time.setAttribute('datetime', wallTime);
      }
      ensureEmptyState(originDay);
      ensureEmptyState(targetDay);
      root.setAttribute('data-preview-dirty', 'true');
      if (restoreFocus) {
        const handle = card.querySelector('[data-calendar-move-handle]');
        if (handle) handle.focus();
      }
      announce(cardLabel(card) + ' moved to ' + dayLabel(targetDay) + ' at ' + label + ' workspace wall time in this browser preview only. It is not saved; reload restores the source snapshot.');
      return true;
    };

    const captureMove = (card) => {
      const originDay = dayForCard(card);
      const container = card && card.parentElement;
      const time = card && card.querySelector('.ccal-time');
      return {
        originDay,
        container,
        nextSibling: card ? card.nextSibling : null,
        scheduledFor: card ? card.dataset.scheduledFor : '',
        previewWallTime: card ? card.dataset.previewWallTime : undefined,
        timeText: time ? time.textContent : '',
        timeDateTime: time ? time.getAttribute('datetime') : null,
      };
    };

    const rollbackMove = (card, snapshot) => {
      if (!card || !snapshot || !snapshot.container) return;
      const currentDay = dayForCard(card);
      if (snapshot.nextSibling && snapshot.nextSibling.parentNode === snapshot.container) {
        snapshot.container.insertBefore(card, snapshot.nextSibling);
      } else {
        snapshot.container.appendChild(card);
      }
      card.dataset.scheduledFor = snapshot.scheduledFor || '';
      if (snapshot.previewWallTime === undefined) card.removeAttribute('data-preview-wall-time');
      else card.dataset.previewWallTime = snapshot.previewWallTime;
      const time = card.querySelector('.ccal-time');
      if (time) {
        time.textContent = snapshot.timeText || '';
        if (snapshot.timeDateTime === null) time.removeAttribute('datetime');
        else time.setAttribute('datetime', snapshot.timeDateTime);
      }
      ensureEmptyState(currentDay);
      ensureEmptyState(snapshot.originDay);
    };

    const openMoveSheet = (card, targetDay, minutes, returnFocus) => {
      if (!sheet || !sheetDate || !sheetTime || !card || !targetDay) return false;
      const rescheduleForm = card.querySelector('[data-calendar-command-form][data-command-kind="reschedule"]');
      const durable = Boolean(rescheduleForm);
      sheetCard = card;
      sheetReturnFocus = returnFocus || card.querySelector('[data-calendar-move-handle]');
      sheetDate.value = targetDay.dataset.date || '';
      sheetTime.value = timeValue(minutes);
      if (sheetCopy) sheetCopy.textContent = durable
        ? 'Review the new desired TEST time, explain the change and confirm. The card rolls back if saving fails.'
        : 'This slot has no protected command boundary. The move remains a browser-only preview and is discarded on reload.';
      if (sheetDurableFields) sheetDurableFields.hidden = !durable;
      if (sheetReason) sheetReason.value = '';
      if (sheetConfirm) sheetConfirm.checked = false;
      if (sheetApply) sheetApply.textContent = durable ? 'Confirm & save TEST time' : 'Move in preview';
      sheetInert = Array.from(root.children)
        .filter((element) => element !== sheet && !element.hasAttribute('data-calendar-live'))
        .map((element) => ({ element, hadInert: element.hasAttribute('inert') }));
      sheetInert.forEach(({ element }) => element.setAttribute('inert', ''));
      sheet.hidden = false;
      sheetDate.focus();
      announce((durable ? 'Durable TEST move confirmation' : 'Browser preview') + ' opened for ' + cardLabel(card) + '.');
      return true;
    };

    const commitLift = () => {
      if (!lifted) return;
      const state = lifted;
      const durable = state.card.querySelector('[data-calendar-command-form][data-command-kind="reschedule"]');
      if (durable && state.targetDay) {
        const card = state.card;
        const targetDay = state.targetDay;
        const minutes = state.minutes;
        const handle = state.handle;
        finishLift();
        openMoveSheet(card, targetDay, minutes, handle);
      } else {
        applyMove(state.card, state.targetDay, state.minutes, false);
        finishLift();
      }
    };

    const moveTargetDay = (delta) => {
      if (!lifted) return;
      const current = dayIndex(lifted.targetDay);
      const next = Math.max(0, Math.min(days.length - 1, current + delta));
      if (next === current) {
        announce('That is the edge of this loaded TEST calendar. Nothing moved.');
        return;
      }
      setTarget(days[next], lifted.minutes);
      if (scroll && days[next] && typeof days[next].scrollIntoView === 'function') {
        days[next].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      }
    };

    const dayAtPoint = (x, y) => {
      const element = document.elementFromPoint(x, y);
      const day = element && typeof element.closest === 'function' ? element.closest('[data-calendar-day]') : null;
      return day && root.contains(day) ? day : null;
    };

    const scrollForPointer = (x) => {
      if (!scroll || typeof scroll.getBoundingClientRect !== 'function') return;
      const bounds = scroll.getBoundingClientRect();
      const edge = Math.min(62, bounds.width / 5);
      const amount = x < bounds.left + edge ? -30 : x > bounds.right - edge ? 30 : 0;
      if (!amount) return;
      if (typeof scroll.scrollBy === 'function') scroll.scrollBy({ left: amount, behavior: 'auto' });
      else scroll.scrollLeft += amount;
    };

    const releasePointer = () => {
      const state = pointerState;
      pointerState = null;
      root.removeAttribute('data-pointer-moving');
      if (state && typeof state.handle.hasPointerCapture === 'function' && state.handle.hasPointerCapture(state.pointerId)) {
        try { state.handle.releasePointerCapture(state.pointerId); } catch {}
      }
      return state;
    };

    handles.forEach((handle) => {
      handle.addEventListener('keydown', (event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !lifted) {
          event.preventDefault();
          beginLift(handle, true);
          return;
        }
        if (!lifted || lifted.handle !== handle) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          finishLift(cardLabel(lifted.card) + ' preview movement cancelled. Nothing changed.');
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          moveTargetDay(1);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          moveTargetDay(-1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setTarget(lifted.targetDay, lifted.minutes - 30);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setTarget(lifted.targetDay, lifted.minutes + 30);
        } else if (event.key === 'Home') {
          event.preventDefault();
          setTarget(days[0], lifted.minutes);
        } else if (event.key === 'End') {
          event.preventDefault();
          setTarget(days[days.length - 1], lifted.minutes);
        } else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          commitLift();
        }
      });

      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || event.isPrimary === false || pointerState) return;
        pointerState = {
          handle,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
        };
      });
    });

    document.addEventListener('pointermove', (event) => {
      const state = pointerState;
      if (!state || state.pointerId !== event.pointerId) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < POINTER_THRESHOLD) return;
        state.active = beginLift(state.handle, false);
        if (!state.active) {
          releasePointer();
          return;
        }
        root.setAttribute('data-pointer-moving', 'true');
        if (typeof state.handle.setPointerCapture === 'function') {
          try { state.handle.setPointerCapture(state.pointerId); } catch {}
        }
      }
      event.preventDefault();
      scrollForPointer(event.clientX);
      const day = dayAtPoint(event.clientX, event.clientY);
      if (day) setTarget(day, lifted ? lifted.minutes : minutesFromCard(state.handle.closest('[data-calendar-slot]')));
    }, { passive: false });

    const endPointer = (event, cancelled) => {
      const state = pointerState;
      if (!state || (event && state.pointerId !== event.pointerId)) return;
      const active = state.active;
      let validDrop = !cancelled;
      if (active && !cancelled && event) {
        const day = dayAtPoint(event.clientX, event.clientY);
        validDrop = Boolean(day);
        if (day && lifted) setTarget(day, lifted.minutes);
      }
      releasePointer();
      if (!active) return;
      if (event) event.preventDefault();
      if (!validDrop || !lifted || !lifted.targetDay) finishLift('TEST preview movement cancelled. Nothing changed.');
      else commitLift();
    };
    document.addEventListener('pointerup', (event) => endPointer(event, false));
    document.addEventListener('pointercancel', (event) => endPointer(event, true));
    window.addEventListener('blur', () => {
      if (pointerState) endPointer(null, true);
      else if (lifted) finishLift('TEST preview movement cancelled. Nothing changed.');
    });

    const closeSheet = () => {
      if (!sheet || sheet.hidden) return;
      sheet.hidden = true;
      sheetInert.forEach(({ element, hadInert }) => {
        if (!hadInert) element.removeAttribute('inert');
      });
      sheetInert = [];
      sheetCard = null;
      if (sheetReturnFocus && sheetReturnFocus.isConnected) sheetReturnFocus.focus();
      sheetReturnFocus = null;
    };

    root.querySelectorAll('[data-calendar-sheet-open]').forEach((button) => {
      button.addEventListener('click', () => {
        const card = button.closest('[data-calendar-slot]');
        const day = dayForCard(card);
        if (!sheet || !sheetDate || !sheetTime || !card || !day) return;
        // A keyboard user can tab from a lifted handle into this button. The
        // sheet is a separate movement mode, so retire the stale lift first.
        if (lifted) finishLift();
        openMoveSheet(card, day, minutesFromCard(card), button);
      });
    });
    if (sheetCancel) sheetCancel.addEventListener('click', closeSheet);
    if (sheetApply) sheetApply.addEventListener('click', () => {
      if (!sheetCard || !sheetDate || !sheetTime) return;
      const target = days.find((day) => day.dataset.date === sheetDate.value);
      const match = /^(\d{2}):(\d{2})$/.exec(sheetTime.value);
      if (!target || !match) {
        announce('Choose a date visible in this loaded TEST calendar and a valid time. Nothing changed.');
        return;
      }
      const minutes = (Number(match[1]) * 60) + Number(match[2]);
      const card = sheetCard;
      const form = card.querySelector('[data-calendar-command-form][data-command-kind="reschedule"]');
      if (form) {
        const reason = String(sheetReason && sheetReason.value || '').trim();
        if (!reason || reason.length > 500) {
          announce('Explain this TEST time change in 500 characters or fewer. Nothing changed.');
          if (sheetReason) sheetReason.focus();
          return;
        }
        if (!sheetConfirm || !sheetConfirm.checked) {
          announce('Confirm the new immutable TEST time before saving. Nothing changed.');
          if (sheetConfirm) sheetConfirm.focus();
          return;
        }
        const desired = form.querySelector('[data-calendar-reschedule-time]');
        const formReason = form.querySelector('textarea[name="reason"]');
        const formConfirm = form.querySelector('input[name="confirm_change"]');
        if (!desired || !formReason || !formConfirm) {
          announce('The protected reschedule form is unavailable. Nothing changed.');
          return;
        }
        desired.value = sheetDate.value + 'T' + timeValue(minutes);
        formReason.value = reason;
        formConfirm.checked = true;
        form.dataset.confirmedBySheet = 'true';
        closeSheet();
        form.requestSubmit();
      } else {
        closeSheet();
        applyMove(card, target, minutes, true);
      }
    });
    if (sheet) {
      sheet.addEventListener('click', (event) => { if (event.target === sheet) closeSheet(); });
      sheet.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSheet();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusable = Array.from(sheet.querySelectorAll('input,button:not([disabled])'));
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });
    }

    const safeResponseMessage = (value, fallback) => {
      const message = typeof value === 'string' ? value.trim() : '';
      return message && message.length <= 500 && !/[\u0000-\u001f\u007f-\u009f]/u.test(message)
        ? message
        : fallback;
    };

    const parseBoundedJson = async (response) => {
      const body = await response.text();
      if (body.length > 8192) throw new Error('Response exceeded safe UI bound');
      return body ? JSON.parse(body) : {};
    };

    const liveForm = root.querySelector('[data-calendar-live-form]');
    if (liveForm) {
      const dateField = liveForm.querySelector('[data-calendar-live-date]');
      const dateLabel = liveForm.querySelector('[data-calendar-live-date-label]');
      const dateTrigger = liveForm.querySelector('[data-calendar-date-trigger]');
      const datePopover = liveForm.querySelector('[data-calendar-date-popover]');
      const dateGrid = liveForm.querySelector('[data-calendar-date-grid]');
      const dateMonth = liveForm.querySelector('[data-calendar-date-month]');
      const datePrevious = liveForm.querySelector('[data-calendar-date-previous]');
      const dateNext = liveForm.querySelector('[data-calendar-date-next]');
      const dateToday = liveForm.querySelector('[data-calendar-date-today]');
      const timeField = liveForm.querySelector('[data-calendar-live-time]');
      const scheduledField = liveForm.querySelector('[name="scheduled_for_local"]');
      const mediaDrop = liveForm.querySelector('[data-calendar-media-drop]');
      const mediaChoose = liveForm.querySelector('[data-calendar-media-choose]');
      const mediaInput = liveForm.querySelector('[data-calendar-media-input]');
      const mediaType = liveForm.querySelector('[name="media_type"]');
      const mediaUrl = liveForm.querySelector('[name="media_url"]');
      const mediaPreview = liveForm.querySelector('[data-calendar-media-preview]');
      const mediaVisual = liveForm.querySelector('[data-calendar-media-visual]');
      const mediaName = liveForm.querySelector('[data-calendar-media-name]');
      const mediaRemove = liveForm.querySelector('[data-calendar-media-remove]');
      const liveStatus = liveForm.querySelector('[data-calendar-live-status]');
      const liveSubmit = liveForm.querySelector('[data-calendar-live-submit]');
      let previewUrl = '';
      let uploadBusy = false;
      const localDate = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
      };
      const nextSuggested = (clock) => {
        const parts = clock.split(':').map(Number);
        const choice = new Date();
        choice.setHours(parts[0], parts[1], 0, 0);
        if (choice.getTime() < Date.now() + 5 * 60 * 1000) choice.setDate(choice.getDate() + 1);
        return choice;
      };
      const clockMinutes = (clock) => {
        const match = /^(\d{2}):(\d{2})$/.exec(String(clock || '').trim());
        if (!match) return null;
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
          ? (hour * 60) + minute : null;
      };
      const setClockMinutes = (minutes) => {
        if (!timeField) return;
        const bounded = ((minutes % 1440) + 1440) % 1440;
        timeField.value = String(Math.floor(bounded / 60)).padStart(2, '0') + ':'
          + String(bounded % 60).padStart(2, '0');
        syncSchedule();
      };
      const syncSchedule = () => {
        if (dateLabel && dateField && dateField.value) {
          const parts = dateField.value.split('-').map(Number);
          const localChoice = new Date(parts[0], parts[1] - 1, parts[2]);
          dateLabel.textContent = new Intl.DateTimeFormat('en-GB', {
            weekday: 'long', day: 'numeric', month: 'long'
          }).format(localChoice);
        }
        const validClock = timeField ? clockMinutes(timeField.value) !== null : false;
        if (scheduledField) scheduledField.value = dateField && timeField && dateField.value && validClock
          ? dateField.value + 'T' + timeField.value.trim()
          : '';
      };
      const setLiveStatus = (message) => {
        if (liveStatus) liveStatus.textContent = message;
        announce(message);
      };
      const clearMedia = () => {
        if (previewUrl) window.URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        if (mediaInput) mediaInput.value = '';
        if (mediaType) mediaType.value = '';
        if (mediaUrl) mediaUrl.value = '';
        if (mediaVisual) mediaVisual.replaceChildren();
        if (mediaName) mediaName.textContent = '';
        if (mediaPreview) {
          mediaPreview.hidden = true;
          mediaPreview.removeAttribute('data-upload-state');
        }
        setLiveStatus('Media removed. The post will be text only.');
      };
      const firstChoice = nextSuggested('17:35');
      let dateCursor = new Date(firstChoice.getFullYear(), firstChoice.getMonth(), 1);
      const closeDatePicker = (restoreFocus) => {
        if (!datePopover || datePopover.hidden) return;
        datePopover.hidden = true;
        if (dateTrigger) {
          dateTrigger.setAttribute('aria-expanded', 'false');
          if (restoreFocus) dateTrigger.focus();
        }
      };
      const renderDatePicker = () => {
        if (!dateGrid || !dateMonth || !dateField) return;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const first = new Date(dateCursor.getFullYear(), dateCursor.getMonth(), 1);
        const offset = (first.getDay() + 6) % 7;
        const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
        dateMonth.textContent = new Intl.DateTimeFormat('en-GB', {
          month: 'long', year: 'numeric'
        }).format(first);
        dateGrid.replaceChildren();
        for (let index = 0; index < 42; index += 1) {
          const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
          const value = localDate(day);
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ccal-date-day';
          button.textContent = String(day.getDate());
          button.dataset.otherMonth = String(day.getMonth() !== first.getMonth());
          button.setAttribute('aria-label', new Intl.DateTimeFormat('en-GB', {
            weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
          }).format(day));
          button.setAttribute('aria-pressed', String(value === dateField.value));
          button.disabled = day.getTime() < today.getTime();
          button.addEventListener('click', () => {
            dateField.value = value;
            dateCursor = new Date(day.getFullYear(), day.getMonth(), 1);
            syncSchedule();
            closeDatePicker(true);
            setLiveStatus('Publication date selected. Choose any exact minute.');
          });
          dateGrid.appendChild(button);
        }
        if (datePrevious) {
          datePrevious.disabled = first.getFullYear() === today.getFullYear()
            && first.getMonth() <= today.getMonth();
        }
      };
      if (dateField) {
        dateField.min = localDate(new Date());
        dateField.value = localDate(firstChoice);
        dateField.addEventListener('change', syncSchedule);
      }
      if (timeField) {
        timeField.value = String(firstChoice.getHours()).padStart(2, '0') + ':'
          + String(firstChoice.getMinutes()).padStart(2, '0');
        timeField.addEventListener('input', syncSchedule);
        timeField.addEventListener('change', syncSchedule);
        timeField.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          const current = clockMinutes(timeField.value);
          if (current === null) return;
          event.preventDefault();
          setClockMinutes(current + (event.key === 'ArrowUp' ? 1 : -1));
        });
      }
      liveForm.querySelectorAll('[data-calendar-time-step]').forEach((button) => {
        button.addEventListener('click', () => {
          const current = clockMinutes(timeField && timeField.value);
          const delta = Number(button.dataset.calendarTimeStep);
          if (current === null || !Number.isSafeInteger(delta)) return;
          setClockMinutes(current + delta);
          setLiveStatus(delta > 0 ? 'Moved one minute later.' : 'Moved one minute earlier.');
        });
      });
      if (dateTrigger && datePopover) {
        dateTrigger.addEventListener('click', () => {
          const opening = datePopover.hidden;
          if (!opening) {
            closeDatePicker(false);
            return;
          }
          const selected = dateField && dateField.value ? new Date(dateField.value + 'T12:00:00') : firstChoice;
          dateCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
          renderDatePicker();
          datePopover.hidden = false;
          dateTrigger.setAttribute('aria-expanded', 'true');
          const selectedButton = dateGrid && dateGrid.querySelector('[aria-pressed="true"]');
          if (selectedButton) selectedButton.focus();
        });
        datePrevious?.addEventListener('click', () => {
          dateCursor = new Date(dateCursor.getFullYear(), dateCursor.getMonth() - 1, 1);
          renderDatePicker();
        });
        dateNext?.addEventListener('click', () => {
          dateCursor = new Date(dateCursor.getFullYear(), dateCursor.getMonth() + 1, 1);
          renderDatePicker();
        });
        dateToday?.addEventListener('click', () => {
          const today = new Date();
          dateField.value = localDate(today);
          dateCursor = new Date(today.getFullYear(), today.getMonth(), 1);
          syncSchedule();
          closeDatePicker(true);
          setLiveStatus('Today selected. Choose any exact minute.');
        });
        document.addEventListener('pointerdown', (event) => {
          if (!datePopover.hidden && !datePopover.contains(event.target)
              && !dateTrigger.contains(event.target)) closeDatePicker(false);
        });
        liveForm.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && !datePopover.hidden) {
            event.preventDefault();
            closeDatePicker(true);
          }
        });
        liveForm.classList.add('ccal-live-controls-ready');
      }
      syncSchedule();
      liveForm.querySelectorAll('[data-calendar-suggestion-time]').forEach((button) => {
        button.addEventListener('click', () => {
          const clock = button.dataset.calendarSuggestionTime || '';
          if (!/^\d{2}:\d{2}$/.test(clock)) return;
          const choice = nextSuggested(clock);
          if (dateField) dateField.value = localDate(choice);
          if (timeField) timeField.value = clock;
          syncSchedule();
          setLiveStatus(button.textContent.trim() + ' selected. You can still edit the exact minute.');
        });
      });
      if (mediaRemove) mediaRemove.addEventListener('click', clearMedia);
      const uploadMediaFile = async (file) => {
        if (!file) return;
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
          'video/mp4', 'video/quicktime', 'video/webm'];
        if (!allowed.includes(file.type) || file.size < 1 || file.size > 500000000) {
          clearMedia();
          setLiveStatus('Choose a supported image or video up to 500 MB.');
          return;
        }
        if (mediaType) mediaType.value = '';
        if (mediaUrl) mediaUrl.value = '';
        if (previewUrl) window.URL.revokeObjectURL(previewUrl);
        previewUrl = window.URL.createObjectURL(file);
        if (mediaVisual) {
          const visual = document.createElement(file.type.startsWith('image/') ? 'img' : 'video');
          visual.src = previewUrl;
          visual.alt = file.type.startsWith('image/') ? 'Selected post image preview' : '';
          if (!file.type.startsWith('image/')) visual.muted = true;
          mediaVisual.replaceChildren(visual);
        }
        if (mediaName) mediaName.textContent = file.name + ' · uploading…';
        if (mediaPreview) {
          mediaPreview.hidden = false;
          mediaPreview.dataset.uploadState = 'uploading';
        }
        const endpoint = sameOriginUrl(liveForm.dataset.mediaUploadUrl);
        if (!endpoint || !window.fetch) {
          if (mediaName) mediaName.textContent = file.name + ' · upload unavailable';
          if (mediaPreview) mediaPreview.dataset.uploadState = 'failed';
          setLiveStatus('Upload failed: media upload is temporarily unavailable.');
          return;
        }
        uploadBusy = true;
        if (liveSubmit) liveSubmit.disabled = true;
        setLiveStatus('Preparing and uploading ' + file.name + '…');
        try {
          const request = new window.URLSearchParams();
          request.set('_csrf', (liveForm.querySelector('[name="_csrf"]') || {}).value || '');
          request.set('command_key', liveForm.dataset.mediaCommandKey || '');
          request.set('filename', file.name);
          request.set('content_type', file.type);
          request.set('size', String(file.size));
          const preparedResponse = await window.fetch(endpoint.href, {
            method: 'POST', body: request, credentials: 'same-origin',
            headers: { Accept: 'application/json', 'X-Requested-With': 'ContentCalendarMedia' },
          });
          const prepared = await parseBoundedJson(preparedResponse);
          if (!preparedResponse.ok || prepared.ok !== true
              || typeof prepared.uploadUrl !== 'string' || typeof prepared.publicUrl !== 'string'
              || !['image', 'video'].includes(prepared.mediaType)) {
            throw new Error(safeResponseMessage(prepared.message, 'The media could not be prepared.'));
          }
          const uploaded = await window.fetch(prepared.uploadUrl, {
            method: 'PUT', body: file, headers: { 'Content-Type': file.type },
          });
          if (!uploaded.ok) throw new Error('The media upload did not complete.');
          if (mediaType) mediaType.value = prepared.mediaType;
          if (mediaUrl) mediaUrl.value = prepared.publicUrl;
          if (mediaName) mediaName.textContent = file.name + ' · ready';
          if (mediaPreview) mediaPreview.dataset.uploadState = 'ready';
          setLiveStatus('Media ready. Choose the exact date and time, then schedule your post.');
        } catch (error) {
          if (mediaType) mediaType.value = '';
          if (mediaUrl) mediaUrl.value = '';
          if (mediaName) mediaName.textContent = file.name + ' · upload failed';
          if (mediaPreview) mediaPreview.dataset.uploadState = 'failed';
          const reason = error instanceof Error ? error.message : 'The media upload could not complete.';
          setLiveStatus('Upload failed: ' + reason);
        } finally {
          uploadBusy = false;
          if (liveSubmit) liveSubmit.disabled = false;
          if (mediaDrop) mediaDrop.removeAttribute('data-drag-active');
        }
      };
      if (mediaChoose && mediaInput) {
        mediaChoose.addEventListener('click', () => mediaInput.click());
      }
      if (mediaInput) mediaInput.addEventListener('change', () => {
        void uploadMediaFile(mediaInput.files && mediaInput.files[0]);
      });
      if (mediaDrop) {
        const acceptsFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
        mediaDrop.addEventListener('dragenter', (event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          mediaDrop.setAttribute('data-drag-active', 'true');
          setLiveStatus('Drop the image or video to add it to this post.');
        });
        mediaDrop.addEventListener('dragover', (event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
          mediaDrop.setAttribute('data-drag-active', 'true');
        });
        mediaDrop.addEventListener('dragleave', (event) => {
          if (event.relatedTarget && mediaDrop.contains(event.relatedTarget)) return;
          mediaDrop.removeAttribute('data-drag-active');
        });
        mediaDrop.addEventListener('drop', (event) => {
          if (!acceptsFiles(event)) return;
          event.preventDefault();
          mediaDrop.removeAttribute('data-drag-active');
          const files = event.dataTransfer && event.dataTransfer.files;
          void uploadMediaFile(files && files[0]);
        });
      }
      liveForm.addEventListener('submit', (event) => {
        syncSchedule();
        if (uploadBusy || !scheduledField || !scheduledField.value) {
          event.preventDefault();
          setLiveStatus(uploadBusy ? 'Wait for the media upload to finish.' : 'Choose a date and exact time.');
        }
      });
    }

    root.addEventListener('submit', async (event) => {
      const form = event.target && event.target.closest
        ? event.target.closest('[data-calendar-command-form]')
        : null;
      if (!form || !root.contains(form)) return;
      const url = sameOriginUrl(form.action);
      if (!url || typeof window.fetch !== 'function' || typeof window.FormData !== 'function'
          || typeof window.URLSearchParams !== 'function') return;
      const confirmedBySheet = form.dataset.confirmedBySheet === 'true';
      delete form.dataset.confirmedBySheet;
      const confirmMessage = form.dataset.confirmMessage;
      if (!confirmedBySheet && confirmMessage && !window.confirm(confirmMessage)) {
        event.preventDefault();
        setFormStatus(form, 'TEST command cancelled. Nothing changed.');
        return;
      }
      event.preventDefault();
      if (form.getAttribute('aria-busy') === 'true') return;

      const kind = form.dataset.commandKind || 'command';
      const card = form.closest('[data-calendar-slot]');
      const buttons = Array.from(form.querySelectorAll('button, input[type="submit"]'));
      const moveSnapshot = kind === 'reschedule' && card ? captureMove(card) : null;
      let moved = false;
      if (kind === 'reschedule' && card) {
        const desired = form.querySelector('[data-calendar-reschedule-time]');
        const match = desired && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(desired.value);
        const target = match ? days.find((day) => day.dataset.date === match[1]) : null;
        if (match && target) moved = applyMove(card, target, (Number(match[2]) * 60) + Number(match[3]), false);
      }
      form.setAttribute('aria-busy', 'true');
      buttons.forEach((button) => { button.disabled = true; });
      if (card) card.setAttribute('data-command-state', 'saving');
      setFormStatus(form, kind === 'cancel'
        ? 'Cancelling exact TEST target…'
        : kind === 'create'
          ? 'Creating durable TEST planning intent…'
          : 'Saving new immutable TEST time…');

      try {
        const response = await window.fetch(url.href, {
          method: 'POST',
          body: new window.URLSearchParams(new window.FormData(form)),
          credentials: 'same-origin',
          redirect: 'follow',
          headers: {
            Accept: 'application/json',
            'X-Requested-With': 'ContentCalendar',
          },
        });
        const contentType = response.headers.get('content-type') || '';
        if ((response.redirected || contentType.includes('text/html')) && response.ok) {
          const redirect = sameOriginUrl(response.url);
          if (!redirect) throw new Error('Unsafe response redirect');
          window.location.assign(redirect.href);
          return;
        }
        const payload = contentType.includes('application/json')
          ? await parseBoundedJson(response)
          : {};
        if (!response.ok || payload.ok === false) throw new Error('Protected command failed');
        const message = safeResponseMessage(payload.message, kind === 'cancel'
          ? 'Exact TEST target cancelled. Provider effects remain none.'
          : kind === 'create'
            ? 'Durable TEST planning intent created. No provider was called.'
            : 'New immutable TEST time saved. Provider effects remain none.');
        if (card) card.setAttribute('data-command-state', 'saved');
        if (moved) root.removeAttribute('data-preview-dirty');
        setFormStatus(form, message);
      } catch {
        if (moved && card && moveSnapshot) rollbackMove(card, moveSnapshot);
        if (card) card.setAttribute('data-command-state', 'error');
        setFormStatus(form, 'The TEST command was not saved. The visible calendar was rolled back; refresh before retrying.');
      } finally {
        form.removeAttribute('aria-busy');
        buttons.forEach((button) => { button.disabled = false; });
      }
    });

    const outcome = root.querySelector('[data-calendar-jit-status-url]');
    if (outcome && typeof window.fetch === 'function') {
      const statusUrl = sameOriginUrl(outcome.dataset.calendarJitStatusUrl);
      const detail = outcome.querySelector('[data-calendar-outcome-detail]');
      if (statusUrl && detail) {
        outcome.setAttribute('data-jit-loading', 'true');
        window.fetch(statusUrl.href, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Requested-With': 'ContentCalendarStatus' },
        }).then(async (response) => {
          if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return;
          const payload = await parseBoundedJson(response);
          detail.textContent = safeResponseMessage(payload.message, detail.textContent);
        }).catch(() => {
          // The server-rendered PRG outcome remains authoritative and visible.
        }).finally(() => outcome.removeAttribute('data-jit-loading'));
      }
    }
  };

  const enhanceComposer = (root) => {
    root.classList.add('scomp-enhanced');
    const fields = Array.from(root.querySelectorAll('[data-composer-field]'));
    const reset = root.querySelector('[data-composer-reset]');
    const status = root.querySelector('[data-composer-local-status]');
    const originals = new Map(fields.map((field) => [field, field.value]));
    let dirtyAnnounced = false;

    const announce = (message) => {
      if (!status) return;
      status.textContent = '';
      window.setTimeout(() => { status.textContent = message; }, 20);
    };

    const update = (field, announceChange) => {
      const key = field.dataset.composerField;
      if (!key) return;
      root.querySelectorAll('[data-composer-preview="' + key + '"]').forEach((target) => {
        target.textContent = field.value;
      });
      root.querySelectorAll('[data-composer-count-for="' + key + '"]').forEach((target) => {
        const limit = Number(target.dataset.limit || 0);
        const count = codePointCount(field.value);
        target.textContent = limit > 0
          ? count.toLocaleString('en-GB') + ' / ' + limit.toLocaleString('en-GB')
          : count.toLocaleString('en-GB') + ' characters';
        target.setAttribute('data-over-limit', String(limit > 0 && count > limit));
      });
      const dirty = fields.some((entry) => entry.value !== originals.get(entry));
      root.setAttribute('data-local-dirty', String(dirty));
      if (reset) {
        reset.disabled = !dirty;
        reset.setAttribute('aria-disabled', String(!dirty));
      }
      if (!dirty) dirtyAnnounced = false;
      if (announceChange && dirty && !dirtyAnnounced) {
        dirtyAnnounced = true;
        announce('Unsaved browser preview updated. Nothing is saved or sent; reload discards these changes.');
      }
    };

    fields.forEach((field) => {
      field.addEventListener('input', () => update(field, true));
      update(field, false);
    });
    if (reset) {
      reset.addEventListener('click', () => {
        fields.forEach((field) => {
          field.value = originals.get(field) || '';
          update(field, false);
        });
        announce('Local preview reset to the loaded TEST snapshot. Nothing was persisted.');
        const first = fields[0];
        if (first) first.focus();
      });
    }
  };

  document.querySelectorAll('[data-content-calendar]').forEach(enhanceCalendar);
  document.querySelectorAll('[data-social-composer]').forEach(enhanceComposer);
})();`;

/** Backward-compatible descriptive alias for tests and asset composition. */
export const CONTENT_CALENDAR_CLIENT_SCRIPT = CONTENT_CALENDAR_CLIENT_SOURCE;

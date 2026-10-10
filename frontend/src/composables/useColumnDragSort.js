import { onBeforeUnmount, ref } from 'vue';

/** 拖动时只显示落点，松手后移动，避免行重排导致拖动目标抖动。 */
export function useColumnDragSort(rows, saving) {
  const dragging = ref('');
  const target = ref(null);
  let viewport;
  let pointerY = 0;
  let frame;

  function stop() {
    cancelAnimationFrame(frame);
    dragging.value = '';
    target.value = null;
    viewport = null;
  }

  function locate() {
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const y = Math.max(bounds.top, Math.min(pointerY, bounds.bottom));
    const elements = [...viewport.querySelectorAll('[data-column]')];
    const hit =
      elements.find((element) => element.getBoundingClientRect().bottom > y) || elements.at(-1);
    const column = rows.value.find((row) => row.key === hit?.dataset.column);
    if (!column || column.fixed) {
      target.value = null;
      return;
    }
    const rect = hit.getBoundingClientRect();
    target.value = { key: column.key, after: y >= rect.top + rect.height / 2 };
  }

  function scroll() {
    if (!viewport || !dragging.value) return;
    const { top, bottom } = viewport.getBoundingClientRect();
    // 靠近边缘时持续滚动，无需反复松开鼠标再拖动。
    const speed = pointerY < top + 36 ? -10 : pointerY > bottom - 36 ? 10 : 0;
    if (speed) {
      viewport.scrollTop += speed;
      locate();
    }
    frame = requestAnimationFrame(scroll);
  }

  function start(event, column) {
    if (saving.value || column.fixed) return event.preventDefault();
    stop();
    dragging.value = column.key;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', column.key);
    event.dataTransfer.setDragImage(event.currentTarget.closest('[data-column]'), 16, 20);
  }

  function over(event) {
    if (!dragging.value || saving.value) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    pointerY = event.clientY;
    if (!viewport) {
      viewport = event.currentTarget;
      frame = requestAnimationFrame(scroll);
    }
    locate();
  }

  function leave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    cancelAnimationFrame(frame);
    viewport = null;
    target.value = null;
  }

  function drop(event) {
    if (!dragging.value) return;
    event.preventDefault();
    if (!saving.value && target.value && target.value.key !== dragging.value) {
      const source = rows.value.findIndex((row) => row.key === dragging.value);
      const destination = rows.value.findIndex((row) => row.key === target.value.key);
      if (
        source >= 0 &&
        destination >= 0 &&
        !rows.value[source].fixed &&
        !rows.value[destination].fixed
      ) {
        const insertion = destination + Number(target.value.after);
        const [column] = rows.value.splice(source, 1);
        rows.value.splice(insertion - Number(source < insertion), 0, column);
      }
    }
    stop();
  }

  // 手柄保留键盘操作，无法拖动时也能调整顺序。
  function moveByKey(index, offset) {
    const destination = index + offset;
    if (
      saving.value ||
      rows.value[index]?.fixed ||
      !rows.value[destination] ||
      rows.value[destination].fixed
    )
      return;
    const [column] = rows.value.splice(index, 1);
    rows.value.splice(destination, 0, column);
  }

  onBeforeUnmount(stop);
  return { dragging, target, start, over, leave, drop, stop, moveByKey };
}

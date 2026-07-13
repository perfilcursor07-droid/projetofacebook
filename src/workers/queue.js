/**
 * Fila simples em memória: processa uma tarefa por vez para não
 * travar a UI nem saturar CPU/disco. Suficiente até migrar para BullMQ.
 */
const tasks = [];
let running = false;

async function runNext() {
  if (running) return;
  const task = tasks.shift();
  if (!task) return;

  running = true;
  try {
    await task.fn();
  } catch (err) {
    console.error(`[queue] tarefa "${task.name}" falhou:`, err.message);
  } finally {
    running = false;
    setImmediate(runNext);
  }
}

function enqueue(name, fn) {
  tasks.push({ name, fn });
  setImmediate(runNext);
}

function queueSize() {
  return tasks.length + (running ? 1 : 0);
}

module.exports = { enqueue, queueSize };

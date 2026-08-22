/**
 * Desktop virtual privado para autorizar o Claude no próprio servidor.
 * VNC/noVNC escutam somente em 127.0.0.1 e devem ser acessados por túnel SSH.
 */
const logDir = '/home/viralizeai/logs';
const common = {
  cwd: '/home/viralizeai/htdocs/www.viralizeai.online',
  interpreter: 'none',
  autorestart: true,
  restart_delay: 1500,
  max_restarts: 30,
  time: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: 'claude-xvfb',
      script: '/usr/bin/Xvfb',
      args: ':99 -screen 0 1440x1000x24 -nolisten tcp -ac',
      out_file: `${logDir}/claude-xvfb-out.log`,
      error_file: `${logDir}/claude-xvfb-error.log`,
    },
    {
      ...common,
      name: 'claude-openbox',
      script: '/usr/bin/openbox',
      args: '--replace',
      env: { DISPLAY: ':99' },
      out_file: `${logDir}/claude-openbox-out.log`,
      error_file: `${logDir}/claude-openbox-error.log`,
    },
    {
      ...common,
      name: 'claude-vnc',
      script: '/usr/bin/x11vnc',
      args: '-display :99 -forever -shared -localhost -rfbport 5900 -nopw -noxdamage -repeat',
      env: { DISPLAY: ':99' },
      out_file: `${logDir}/claude-vnc-out.log`,
      error_file: `${logDir}/claude-vnc-error.log`,
    },
    {
      ...common,
      name: 'claude-novnc',
      script: '/usr/bin/websockify',
      args: '--web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900',
      out_file: `${logDir}/claude-novnc-out.log`,
      error_file: `${logDir}/claude-novnc-error.log`,
    },
  ],
};

// Entry of the Part workspace page (built to workspace/app.js).
// SPDX-License-Identifier: GPL-3.0-or-later
import './styles/tokens.css';
import './styles/app.css';
import { bootstrap } from './app/bootstrap';

const root = document.getElementById('cad-root');
if (root) void bootstrap(root);

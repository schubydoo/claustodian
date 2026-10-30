// Copyright 2026 Schuby
// SPDX-License-Identifier: Apache-2.0

/**
 * One job of a parallel `reextract-binaries` run (see extractInWorkers). It hands
 * each task from its parent to runTask and reports the reply.
 */
import { runTask, type WorkerTask } from './reextract-binaries.js';

/* v8 ignore next -- runs only in a child process, which coverage does not collect; its logic is runTask, tested in-process */
process.on('message', (task: WorkerTask) => process.send?.(runTask(task)));

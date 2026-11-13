import {
  CORE_RUNTIME,
  SCIENTIFIC_RUNTIME,
} from '@code-along/contracts/execution/profiles';
import { validateArchive } from './archive.ts';

export const TEMPLATES = Object.freeze([
  {
    id: 'functions',
    title: 'A function, two files',
    description:
      'Write a reusable function, import it and change the greeting.',
    archive: validateArchive({
      version: 1,
      name: 'My first Python module',
      runtime_id: CORE_RUNTIME.runtime_id,
      entrypoint: 'main.py',
      files: [
        {
          path: 'main.py',
          source: 'from greeting import greet\n\nprint(greet("River"))\n',
        },
        {
          path: 'greeting.py',
          source:
            'def greet(name):\n    """Return a greeting. Try a different name in main.py."""\n    return f"Hello, {name}!"\n',
        },
      ],
    }),
  },
  {
    id: 'input',
    title: 'Ask, then respond',
    description:
      'Practice input and functions. Choose interactive input in Run options, or provide a line before Run.',
    archive: validateArchive({
      version: 1,
      name: 'A conversation in Python',
      runtime_id: CORE_RUNTIME.runtime_id,
      entrypoint: 'main.py',
      files: [
        {
          path: 'main.py',
          source:
            'def welcome(name):\n    return f"Welcome, {name}!"\n\ntry:\n    name = input("What should we call you? ")\nexcept EOFError:\n    name = "Python learner"\nprint(welcome(name))\n',
        },
      ],
    }),
  },
  {
    id: 'numbers',
    title: 'Find a pattern',
    description:
      'Explore a small NumPy array and draw a line plot with the Code Along helper.',
    archive: validateArchive({
      version: 1,
      name: 'Numbers and patterns',
      runtime_id: SCIENTIFIC_RUNTIME.runtime_id,
      entrypoint: 'main.py',
      files: [
        {
          path: 'main.py',
          source:
            'import numpy as np\nfrom code_along import plot\n\nvalues = np.array([2, 5, 3, 8, 6], dtype=float)\nprint("Mean:", values.mean())\nplot(values.tolist(), title="Try changing these numbers")\n',
        },
      ],
    }),
  },
]);

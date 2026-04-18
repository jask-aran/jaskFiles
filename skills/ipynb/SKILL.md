---
name: ipynb
description: Use when creating, editing, or manipulating Jupyter notebooks (.ipynb files) - including adding/removing cells, modifying cell source, working with Colab form fields, or structuring notebook JSON correctly.
---

# IPYNB Notebook Skill

## Overview

A `.ipynb` file is JSON. Cell `source` is an array of strings (not a single string). Get the structure right or the notebook breaks.

## Notebook Structure

```json
{
  "nbformat": 4,
  "nbformat_minor": 0,
  "metadata": {
    "colab": {"provenance": []},
    "kernelspec": {"name": "python3", "display_name": "Python 3"}
  },
  "cells": [
    {
      "cell_type": "markdown",
      "source": ["line 1\n", "line 2\n"],
      "metadata": {"id": "unique_id"}
    }
  ]
}
```

## Key Rules

**Cell Source Format**
- `source` is an array of strings, each ending with `\n` (except possibly the last)
- NOT a single string
- Example: `["print('hello')\n", "print('world')"]`

**Escaping in JSON**
- Escape quotes: `\"`
- Escape newlines in strings: `\\n` (literal) vs `\n` (actual newline in array)
- Escape backslashes: `\\`

**Cell IDs**
- Each cell needs a unique `metadata.id`
- Use descriptive IDs: `"install_deps"`, `"train_model"`, `"plot_results"`

## Cell Templates

**Markdown Cell**
```python
{
    "cell_type": "markdown",
    "source": [
        "# My Notebook\n",
        "\n",
        "Description here.\n"
    ],
    "metadata": {"id": "intro"}
}
```

**Code Cell**
```python
{
    "cell_type": "code",
    "source": [
        "import torch\n",
        "import numpy as np\n",
        "\n",
        "print('Ready!')\n"
    ],
    "metadata": {"id": "imports"},
    "execution_count": null,
    "outputs": []
}
```

**Colab Form Fields**
```python
"#@title Cell Title { display-mode: \"form\" }\n",
"param = \"default\"  #@param {type:\"string\"}\n",
"number = 10  #@param {type:\"integer\"}\n",
"flag = True  #@param {type:\"boolean\"}\n",
"choice = \"A\"  #@param [\"A\", \"B\", \"C\"]\n",
```

Cells with `#@title` become collapsible sections in Colab when run.

## Editing Notebooks

**Prefer `NotebookEdit` tool** for all cell operations — it handles cells natively:
- Replace a cell: `edit_mode="replace"`, provide `cell_id` and `new_source`
- Insert a new cell: `edit_mode="insert"`, provide `cell_id` of the cell to insert *after*, and `cell_type`
- Delete a cell: `edit_mode="delete"`, provide `cell_id`

Only fall back to raw JSON manipulation when `NotebookEdit` cannot accomplish the task.

**Read → Modify → Write (raw JSON fallback)**
```python
import json

with open('notebook.ipynb', 'r') as f:
    nb = json.load(f)

# Find cell by ID
for cell in nb['cells']:
    if cell.get('metadata', {}).get('id') == 'target_id':
        cell['source'] = ["# updated\n"]
        break

with open('notebook.ipynb', 'w') as f:
    json.dump(nb, f, indent=2)
```

**Insert Cell**
```python
nb['cells'].insert(index, new_cell)
```

**Delete Cell**
```python
nb['cells'] = [c for c in nb['cells'] if c.get('metadata', {}).get('id') != 'cell_to_delete']
```

## Common Patterns

**Setup Cell**
```python
["#@title Setup\n",
 "!pip install -q package1 package2\n",
 "\n",
 "import package1\n",
 "print('✓ Setup complete')\n"]
```

**Config Cell**
```python
["#@title Configuration { display-mode: \"form\" }\n",
 "\n",
 "MODEL_NAME = \"gpt2\"  #@param {type:\"string\"}\n",
 "BATCH_SIZE = 32  #@param {type:\"integer\"}\n",
 "USE_GPU = True  #@param {type:\"boolean\"}\n"]
```

**Progress Display**
```python
["from tqdm.notebook import tqdm\n",
 "\n",
 "for i in tqdm(range(100)):\n",
 "    pass\n"]
```

## Quality Checklist

- [ ] All cells have unique IDs
- [ ] Markdown cells have proper headers
- [ ] Code cells are logically ordered
- [ ] Imports in setup cell at top
- [ ] Config values use Colab form fields where appropriate
- [ ] Clear output messages (`✓` success, `⚠️` warnings)
- [ ] Section dividers between major parts

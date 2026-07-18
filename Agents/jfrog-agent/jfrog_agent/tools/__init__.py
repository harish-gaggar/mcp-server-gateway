"""Typed, allowlisted tools that sit between the LLM and JFrog.

The LLM never emits raw AQL or arbitrary commands. It produces a structured
search intent that a validated builder turns into a safe, bounded, read-only
query. See `aql.py` and `registry.py`.
"""

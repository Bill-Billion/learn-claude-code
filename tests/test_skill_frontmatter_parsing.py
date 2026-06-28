import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_MODULES = [
    ("s07", REPO_ROOT / "s07_skill_loading" / "code.py", "_scan_skills"),
    ("s08", REPO_ROOT / "s08_context_compact" / "code.py", "_scan_skills"),
    ("s20", REPO_ROOT / "s20_comprehensive" / "code.py", "scan_skills"),
]


def load_skill_module(module_name: str, module_path: Path, temp_cwd: Path):
    fake_anthropic = types.ModuleType("anthropic")

    class FakeAnthropic:
        def __init__(self, *args, **kwargs):
            self.messages = types.SimpleNamespace(create=None)

    fake_dotenv = types.ModuleType("dotenv")
    setattr(fake_anthropic, "Anthropic", FakeAnthropic)
    setattr(fake_dotenv, "load_dotenv", lambda override=True: None)

    previous_modules = {
        "anthropic": sys.modules.get("anthropic"),
        "dotenv": sys.modules.get("dotenv"),
    }
    previous_cwd = Path.cwd()
    previous_model_id = os.environ.get("MODEL_ID")

    spec = importlib.util.spec_from_file_location(
        f"{module_name}_frontmatter_test", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {module_path}")
    module = importlib.util.module_from_spec(spec)

    sys.modules["anthropic"] = fake_anthropic
    sys.modules["dotenv"] = fake_dotenv
    try:
        os.chdir(temp_cwd)
        os.environ["MODEL_ID"] = "test-model"
        spec.loader.exec_module(module)
        return module
    finally:
        os.chdir(previous_cwd)
        if previous_model_id is None:
            os.environ.pop("MODEL_ID", None)
        else:
            os.environ["MODEL_ID"] = previous_model_id
        for name, previous in previous_modules.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


class SkillFrontmatterParsingTests(unittest.TestCase):
    def test_scan_skills_falls_back_for_empty_metadata_values(self):
        raw = "---\nname:\ndescription:\n---\n# Body description\n\nDetails"
        for module_name, module_path, scan_name in SKILL_MODULES:
            with self.subTest(module=module_name), tempfile.TemporaryDirectory() as tmp:
                tmp_path = Path(tmp)
                skill_dir = tmp_path / "skills" / "fallback-skill"
                skill_dir.mkdir(parents=True)
                (skill_dir / "SKILL.md").write_text(raw)

                module = load_skill_module(module_name, module_path, tmp_path)
                module.SKILL_REGISTRY.clear()
                getattr(module, scan_name)()

                self.assertIn("fallback-skill", module.SKILL_REGISTRY)
                self.assertEqual(
                    module.SKILL_REGISTRY["fallback-skill"]["description"],
                    "Body description",
                )

    def test_parse_frontmatter_treats_non_mapping_yaml_as_empty_meta(self):
        raw = "---\n- not\n- a\n- mapping\n---\nBody"
        for module_name, module_path, _ in SKILL_MODULES:
            with self.subTest(module=module_name), tempfile.TemporaryDirectory() as tmp:
                module = load_skill_module(module_name, module_path, Path(tmp))

                meta, body = module._parse_frontmatter(raw)

                self.assertEqual(meta, {})
                self.assertEqual(body, "Body")

    def test_parse_frontmatter_requires_opening_delimiter_on_own_line(self):
        raw = "---not frontmatter\n---\n# Body"
        for module_name, module_path, _ in SKILL_MODULES:
            with self.subTest(module=module_name), tempfile.TemporaryDirectory() as tmp:
                module = load_skill_module(module_name, module_path, Path(tmp))

                meta, body = module._parse_frontmatter(raw)

                self.assertEqual(meta, {})
                self.assertEqual(body, raw)


if __name__ == "__main__":
    unittest.main()

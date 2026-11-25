import unittest

from r1_updater.project import Project, field, set_user_password
from gpa_translator.translate import NS


class UserPasswordTests(unittest.TestCase):
    # GPA 6 HashPassword("example-only", "AQIDBAUGBwgJCgsMDQ4PEA")
    sample = "QGG94NQl6pN95IEELVH90Hfz1bjFWGLy8Ng/M61YuPoAQIDBAUGBwgJCgsMDQ4PEA"

    def project(self, password_xml):
        files = {"projects/$p.xml": b"<Project/>"}
        for name in ("User", "Installer"):
            files[f"projects/$p/users/${name}.xml"] = (
                f'<conf:User xmlns:conf="{NS[1:-1]}"><conf:EntityId>{name}</conf:EntityId>'
                f'<conf:EntityName>{name}</conf:EntityName>{password_xml}'
                '<conf:ResetPassword>false</conf:ResetPassword></conf:User>'
            ).encode()
        return Project(files)

    def test_existing_gpa_record_matches_without_rewrite(self):
        project = self.project(f"<conf:Password>{self.sample}</conf:Password>")
        before = project.files.copy()
        self.assertFalse(set_user_password(project, "example-only"))
        self.assertEqual(project.files, before)
        self.assertTrue(set_user_password(project, "Example-only"))
        self.assertEqual([k for k in before if before[k] != project.files[k]], ["projects/$p/users/$User.xml"])

    def test_empty_record_and_repeated_run(self):
        project = self.project("<conf:Password />")
        self.assertTrue(set_user_password(project, "lozinka-č"))
        record = field(project.xml("projects/$p/users/$User"), "Password")
        self.assertRegex(record, r"^[A-Za-z0-9+/]{65}$")
        self.assertFalse(set_user_password(project, "lozinka-č"))

    def test_independent_installer_password(self):
        project = self.project(f"<conf:Password>{self.sample}</conf:Password>")
        before = project.files.copy()
        self.assertTrue(set_user_password(project, "installer-example", "Installer"))
        self.assertEqual([k for k in before if before[k] != project.files[k]], ["projects/$p/users/$Installer.xml"])
        self.assertFalse(set_user_password(project, "installer-example", "Installer"))
        self.assertFalse(set_user_password(project, "example-only", "User"))

    def test_unrecognized_record_rejected(self):
        project = self.project("<conf:Password>unknown</conf:Password>")
        with self.assertRaisesRegex(ValueError, "Neprepoznat"):
            set_user_password(project, "example-only")

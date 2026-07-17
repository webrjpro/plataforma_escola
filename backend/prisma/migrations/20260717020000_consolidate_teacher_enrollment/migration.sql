-- CourseEnrollment is the canonical user/course association.
-- Preserve any assignments created by older releases before removing the
-- duplicate table that was never written by the current administration API.
INSERT INTO "CourseEnrollment" (
    "id",
    "userId",
    "courseId",
    "enrollmentRole",
    "createdAt"
)
SELECT
    'teacher-' || "id",
    "userId",
    "courseId",
    'TEACHER'::"EnrollmentRole",
    "createdAt"
FROM "TeacherCourseAssignment"
ON CONFLICT ("userId", "courseId") DO UPDATE
SET "enrollmentRole" = 'TEACHER'::"EnrollmentRole";

DROP TABLE "TeacherCourseAssignment";

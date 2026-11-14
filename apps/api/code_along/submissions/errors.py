from rest_framework.exceptions import APIException


class SubmissionError(APIException):
    def __init__(self, code: str, detail: str, *, status: int = 409) -> None:
        self.status_code = status
        super().__init__({"code": code, "detail": detail})


def conflict(code: str, detail: str) -> SubmissionError:
    return SubmissionError(code, detail)

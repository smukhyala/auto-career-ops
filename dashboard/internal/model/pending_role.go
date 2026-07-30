package model

// PendingRole is a scan result that has not yet been evaluated or added to the
// application tracker. It deliberately stays separate from CareerApplication:
// discovery is not an application.
type PendingRole struct {
	URL      string
	Company  string
	Role     string
	Location string
	Posted   string
}

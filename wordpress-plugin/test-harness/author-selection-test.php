<?php
// Isolated selector regression: no WordPress install, access grants or publication.
define( 'ABSPATH', __DIR__ );
function get_users( $args ) {
	if ( 'publish_posts' !== $args['capability'] ) { throw new Exception( 'Use a single capability query' ); }
	return array( (object) array( 'ID' => 1 ), (object) array( 'ID' => 2 ), (object) array( 'ID' => 3 ) );
}
function user_can( $id, $cap ) {
	return 1 === $id || ( 2 === $id && 'publish_posts' === $cap );
}
require __DIR__ . '/../relaunch72-publisher/includes/class-r72pub-admin.php';
$authors = R72Pub_Admin::publishing_authors();
if ( 1 !== count( $authors ) || 1 !== $authors[0]->ID ) { throw new Exception( 'Ineligible author admitted or eligible administrator omitted' ); }
echo "Author selector: eligible administrator retained, missing upload/publish capabilities refused.\n";

